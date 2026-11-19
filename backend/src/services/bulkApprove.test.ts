import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conflict } from '../lib/errors.js';

// What matters here is the decision: which records of a batch are approved, which are held back,
// and that the approval itself is still the single-record one. The database and that approval are
// stood in for; the validation and the assessment are the real ones.

const header = {
  id: 'h1', recordId: 'r1', poNumber: 'PO-1', poDate: '2026-09-01', customerName: 'Acme',
  customerCode: 'C-1', shipTo: null, billTo: null, requestedDeliveryDate: '2026-10-01',
  currency: 'EUR', paymentTerms: null, incoterms: null, poTotalValue: '50.00', contact: null,
  updatedAt: new Date(),
  lineItems: [
    { id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
      description: 'Widget', quantity: '10', uom: 'EA', unitPrice: '5.00', lineNetValue: '50.00',
      deliveryDate: null, plant: null },
  ],
};
const record = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'NEEDS_REVIEW', uploadedById: 'uploader-1', sourceDocument: { contentHash: `hash-${id}` },
  header: { ...header, recordId: id }, ...over,
});

let rows: ReturnType<typeof record>[] = [];
let fields: { recordId: string; confidence: number | null; editedAt: Date | null }[] = [];

vi.mock('../db/client.js', () => ({
  prisma: {
    pORecord: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => rows.filter((r) => args.where.id.in.includes(r.id))),
    },
    fieldExtraction: { findMany: vi.fn(async () => fields) },
    validationAck: { findMany: vi.fn(async () => []) },
    auditEvent: { findMany: vi.fn(async () => []) },
  },
}));

const approveRecord = vi.fn();
const findPoNumberDuplicates = vi.fn();
const findDuplicates = vi.fn();
vi.mock('./records.js', () => ({
  approveRecord: (...a: unknown[]) => approveRecord(...a),
  findPoNumberDuplicates: (...a: unknown[]) => findPoNumberDuplicates(...a),
  findDuplicates: (...a: unknown[]) => findDuplicates(...a),
  canApprove: (role: string) => role === 'APPROVER' || role === 'ADMIN',
}));

const writeAudit = vi.fn();
vi.mock('./audit.js', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const { approveMany, assessRecords } = await import('./bulkApprove.js');
const approver = { id: 'approver-1', role: 'APPROVER' as const, name: 'Approver' };

beforeEach(() => {
  vi.clearAllMocks();
  rows = [record('r1'), record('r2'), record('r3')];
  fields = [];
  approveRecord.mockResolvedValue(undefined);
  findPoNumberDuplicates.mockResolvedValue([]);
  findDuplicates.mockResolvedValue([]);
});

describe('assessing records for a batch', () => {
  it('calls a record with nothing flagged clean', async () => {
    expect((await assessRecords(approver, ['r1'])).r1).toEqual({ clean: true, holds: [] });
  });

  it('holds back a record with a field the reading was unsure of, until a person corrects it', async () => {
    fields = [{ recordId: 'r2', confidence: 0.4, editedAt: null }];
    expect((await assessRecords(approver, ['r1', 'r2'])).r2?.holds.map((h) => h.code)).toEqual(['UNSURE_FIELDS']);

    fields = [{ recordId: 'r2', confidence: 0.4, editedAt: new Date() }];
    expect((await assessRecords(approver, ['r2'])).r2?.clean).toBe(true);
  });

  it('holds back a repeat of another record', async () => {
    findPoNumberDuplicates.mockImplementation(async (id: string) => (id === 'r3' ? [{ recordId: 'r9' }] : []));
    const a = await assessRecords(approver, ['r1', 'r3']);
    expect(a.r1?.clean).toBe(true);
    expect(a.r3?.holds.map((h) => h.code)).toEqual(['DUPLICATE']);
  });

  it('leaves out an id that is not a live record', async () => {
    expect(Object.keys(await assessRecords(approver, ['r1', 'nope']))).toEqual(['r1']);
  });

  it('is for approvers only', async () => {
    await expect(assessRecords({ ...approver, role: 'UPLOADER' }, ['r1'])).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
  });
});

describe('approving a batch', () => {
  it('approves the clean ones and leaves the others where they are, saying why', async () => {
    fields = [{ recordId: 'r2', confidence: 0.4, editedAt: null }];
    const outcomes = await approveMany(approver, ['r1', 'r2', 'r3']);

    expect(outcomes.map((o) => `${o.id}:${o.result}`)).toEqual(['r1:approved', 'r2:held', 'r3:approved']);
    expect(outcomes[1]).toMatchObject({ holds: [{ code: 'UNSURE_FIELDS' }] });
    expect(approveRecord).toHaveBeenCalledTimes(2);
    expect(approveRecord).toHaveBeenCalledWith(approver, 'r1');
    expect(approveRecord).not.toHaveBeenCalledWith(approver, 'r2');
  });

  it("never approves the approver's own upload", async () => {
    rows = [record('r1', { uploadedById: 'approver-1' })];
    const [o] = await approveMany(approver, ['r1']);
    expect(o).toMatchObject({ result: 'held', holds: [{ code: 'OWN_UPLOAD' }] });
    expect(approveRecord).not.toHaveBeenCalled();
  });

  it('reports a record someone else approved first, and carries on with the rest', async () => {
    approveRecord.mockImplementation(async (_a: unknown, id: string) => {
      if (id === 'r2') throw conflict('This record was approved or changed by someone else a moment ago.', 'CONCURRENT_UPDATE');
    });
    const outcomes = await approveMany(approver, ['r1', 'r2', 'r3']);
    expect(outcomes.map((o) => o.result)).toEqual(['approved', 'failed', 'approved']);
    expect(outcomes[1]).toMatchObject({ code: 'CONCURRENT_UPDATE' });
  });

  it('notes in the history of each approved record that it went in a batch', async () => {
    await approveMany(approver, ['r1', 'r3']);
    expect(writeAudit).toHaveBeenCalledTimes(2);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 'r1', eventType: 'APPROVED_IN_BATCH', actorId: 'approver-1' }),
    );
  });

  it('keeps the approval when the history note cannot be written', async () => {
    writeAudit.mockRejectedValueOnce(new Error('db down'));
    const [o] = await approveMany(approver, ['r1']);
    expect(o).toEqual({ id: 'r1', result: 'approved' });
  });

  it('takes each record once, and says so when one has vanished', async () => {
    const outcomes = await approveMany(approver, ['r1', 'r1', 'gone']);
    expect(outcomes.map((o) => `${o.id}:${o.result}`)).toEqual(['r1:approved', 'gone:failed']);
    expect(approveRecord).toHaveBeenCalledTimes(1);
  });

  it('refuses outright for a role that cannot approve', async () => {
    await expect(approveMany({ ...approver, role: 'OPERATIONS' }, ['r1'])).rejects.toMatchObject({ code: 'NOT_AN_APPROVER' });
    expect(approveRecord).not.toHaveBeenCalled();
  });
});
