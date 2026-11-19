import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { markAcknowledged } from '../domain/acknowledgement.js';
import { assessForBulkApproval, type Assessment, type Hold } from '../domain/bulkApproval.js';
import { deriveSentBack } from '../domain/sentBack.js';
import { validateRecord } from '../domain/validation.js';
import { AppError, forbidden } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import { writeAudit } from './audit.js';
import { approveRecord, canApprove, findDuplicates, findPoNumberDuplicates, type Actor } from './records.js';

const log = childLogger('bulk-approve');

/** How many records are looked at in parallel; each one is a handful of small queries. */
const CHUNK = 10;

const requireApprover = (actor: Actor) => {
  if (!canApprove(actor.role)) throw forbidden('Your role cannot approve records.', 'NOT_AN_APPROVER');
};

/**
 * For each id, whether it could go in a batch and, when not, why. An id that is not a live
 * record is left out of the answer.
 */
export async function assessRecords(actor: Actor, ids: string[]): Promise<Record<string, Assessment>> {
  requireApprover(actor);
  if (ids.length === 0) return {};

  const records = await prisma.pORecord.findMany({
    where: { id: { in: ids }, deletedAt: null },
    include: {
      sourceDocument: { select: { contentHash: true } },
      header: { include: { lineItems: { orderBy: { lineNumber: 'asc' } } } },
    },
  });
  const found = records.map((r) => r.id);

  const [fields, acks, audit] = await Promise.all([
    prisma.fieldExtraction.findMany({
      where: { recordId: { in: found } },
      select: { recordId: true, confidence: true, editedAt: true },
    }),
    prisma.validationAck.findMany({
      where: { recordId: { in: found } },
      include: { acknowledgedBy: { select: { name: true } } },
    }),
    prisma.auditEvent.findMany({
      where: { recordId: { in: found }, eventType: { in: ['WARNING_ACKNOWLEDGED', 'APPROVAL_REJECTED', 'APPROVED'] } },
      orderBy: { timestamp: 'asc' },
    }),
  ]);

  const out: Record<string, Assessment> = {};
  for (let i = 0; i < records.length; i += CHUNK) {
    await Promise.all(
      records.slice(i, i + CHUNK).map(async (record) => {
        const myAcks = acks.filter((a) => a.recordId === record.id);
        const myAudit = audit.filter((a) => a.recordId === record.id);
        const issues = markAcknowledged(await validateRecord(record.header), myAcks, myAudit);
        const hash = record.sourceDocument?.contentHash;
        const [samePo, sameFile] = await Promise.all([
          findPoNumberDuplicates(record.id),
          hash ? findDuplicates(hash, record.id) : Promise.resolve([]),
        ]);
        out[record.id] = assessForBulkApproval({
          status: record.status,
          uploadedById: record.uploadedById,
          actorId: actor.id,
          requireSeparateApprover: env.SOD_REQUIRE_SEPARATE_APPROVER,
          issues,
          unsureFields: fields.filter(
            (f) =>
              f.recordId === record.id &&
              f.editedAt == null &&
              f.confidence != null &&
              f.confidence < env.CONFIDENCE_THRESHOLD,
          ).length,
          sentBack: deriveSentBack(record.status, myAudit) != null,
          duplicates: samePo.length + sameFile.length,
        });
      }),
    );
  }
  return out;
}

export type BulkOutcome =
  | { id: string; result: 'approved' }
  | { id: string; result: 'held'; holds: Hold[] }
  | { id: string; result: 'failed'; code: string; message: string };

/**
 * Approve the records in `ids` that are clean, one after another, and report what became of
 * each. Nothing here is all-or-nothing, and nothing is taken on the caller's word: every
 * record is assessed again at the moment it is approved, and then goes through exactly the
 * checks a single approval does (role, separate approver, blocking issues, unaccepted
 * warnings, a claim that fails if someone else got there first). A record that is not clean
 * is not approved, and is returned with the reasons.
 */
export async function approveMany(actor: Actor, ids: string[]): Promise<BulkOutcome[]> {
  requireApprover(actor);
  const unique = [...new Set(ids)];
  const outcomes: BulkOutcome[] = [];

  for (const id of unique) {
    const assessment = (await assessRecords(actor, [id]))[id];
    if (!assessment) {
      outcomes.push({ id, result: 'failed', code: 'NOT_FOUND', message: 'This record no longer exists.' });
      continue;
    }
    if (!assessment.clean) {
      outcomes.push({ id, result: 'held', holds: assessment.holds });
      continue;
    }
    try {
      await approveRecord(actor, id);
    } catch (err) {
      outcomes.push({
        id,
        result: 'failed',
        code: err instanceof AppError ? err.code : 'ERROR',
        message: err instanceof Error ? err.message : 'It could not be approved.',
      });
      continue;
    }
    outcomes.push({ id, result: 'approved' });
    // The approval stands whether or not this note is written; it is there so the history
    // shows the record was approved from the list rather than from its own screen.
    try {
      await writeAudit({
        recordId: id,
        eventType: 'APPROVED_IN_BATCH',
        message: `Approved from the worklist in a batch of ${unique.length}; nothing was flagged on it`,
        actorId: actor.id,
      });
    } catch (err) {
      log.warn({ err, recordId: id }, 'approved in a batch, but the audit note could not be written');
    }
  }
  return outcomes;
}
