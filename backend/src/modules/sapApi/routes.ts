import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { sapApiAuth } from '../../middleware/sapApiAuth.js';
import { isWaitingForSap, WAITING_FOR_SAP } from './shareLink.js';
import { requireJsonBody } from '../../middleware/sapBody.js';
import {
  OutboundFormatError,
  buildOutboundJson,
  buildOutboundPayload,
  outboundBaseName,
} from '../../services/sap/csv.js';
import { ingestApiResult } from '../../services/sap/resultWatcher.js';
import { VbelnError, soNumberFromBody } from '../../services/sap/vbeln.js';

/**
 * The HTTPS door for SAP (FR-9.13): the same exchange as the folders, over a URL.
 *
 *   GET  /api/integration/sap/orders        the approved orders SAP has not yet answered
 *   GET  /api/integration/sap/orders/:id    one of them, by correlation ID
 *   GET  /api/integration/sap/orders/:id/csv  that order as the CSV file the folder drop writes
 *   GET  /api/integration/sap/po            one address for a SAP job that can use only one link: the oldest waiting order as CSV
 *   POST /api/integration/sap/po            ...and its answer, named by PO number: {"PO_NUMBER","VBELN"}
 *   GET  /api/integration/sap/test-files/:name  a fixed test CSV from backend/test-files, bytes unchanged
 *   POST /api/integration/sap/results       SAP's answer: the Sales Order, or why not
 *   POST /api/integration/sap/orders/:id/result  the short form: a success, as just the Sales Order number
 *
 * An order stays on the list until its answer is posted, so SAP can fetch it again if its
 * own job failed halfway. The answer goes through the very rules a result file does.
 */
export const sapApiRouter = Router();
sapApiRouter.use(sapApiAuth);

/** For SAP's side to test the connection and the key without touching any order. */
sapApiRouter.get('/ping', (_req, res) => {
  res.json({ ok: true, system: 'po-cockpit', time: new Date().toISOString() });
});

const recordWithLines = { header: { include: { lineItems: true } } } as const;

sapApiRouter.get('/orders', async (req, res, next) => {
  try {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const records = await prisma.pORecord.findMany({
      // Sent, and also past the wait with no answer: SAP's late answer is still taken.
      where: { OR: WAITING_FOR_SAP, deletedAt: null },
      orderBy: { sentToSapAt: 'asc' },
      take: limit,
      include: recordWithLines,
    });

    const orders: ReturnType<typeof buildOutboundJson>[] = [];
    // An order that cannot be written in SAP's formats is reported, not silently left out,
    // and does not hold up the others.
    const problems: { correlationId: string; error: string }[] = [];
    for (const r of records) {
      if (!r.header) continue;
      try {
        orders.push(buildOutboundJson(r.correlationId, r.currentAttempt, r.header));
      } catch (err) {
        if (!(err instanceof OutboundFormatError)) throw err;
        problems.push({ correlationId: r.correlationId, error: err.message });
      }
    }
    res.json({ orders, problems });
  } catch (err) {
    next(err);
  }
});

/** One order that is with SAP, or the reason it cannot be handed over. */
async function findWaitingOrder(correlationId: string) {
  const record = await prisma.pORecord.findFirst({
    where: { correlationId, deletedAt: null },
    include: recordWithLines,
  });
  if (!record) throw notFound('No order has that correlation ID.');
  if (!isWaitingForSap(record.status, record.failureCode) || !record.header) {
    throw conflict(`That order is ${record.status}, not waiting for SAP.`, 'NOT_WAITING_FOR_SAP', { status: record.status });
  }
  return { ...record, header: record.header };
}

/**
 * The order as the file the folder drop writes, with its correlation ID in the X-Correlation-Id header as
 * well as in the file name. Shared by the per-order address and the single address (/po).
 */
function sendOrderCsv(
  res: Response,
  record: { correlationId: string; currentAttempt: number; header: Parameters<typeof buildOutboundPayload>[2] },
  file?: 'H' | 'L',
) {
  let payload: ReturnType<typeof buildOutboundPayload>;
  try {
    payload = buildOutboundPayload(record.correlationId, record.currentAttempt, record.header);
  } catch (err) {
    if (!(err instanceof OutboundFormatError)) throw err;
    throw new AppError(422, err.message, 'ORDER_NOT_WRITABLE');
  }

  let part = payload.files[0]!;
  if (payload.files.length > 1) {
    if (!file) {
      throw badRequest('This Business Command Centre writes a header file and a lines file for each order. Ask for one with ?file=H or ?file=L.', 'FILE_REQUIRED');
    }
    part = payload.files.find((f) => f.suffix === `_${file}.csv`)!;
  }

  res.type('text/csv');
  res.set('Content-Disposition', `attachment; filename="${outboundBaseName(record.correlationId, record.currentAttempt)}${part.suffix}"`);
  res.set('X-Correlation-Id', record.correlationId);
  res.send(part.content);
}

sapApiRouter.get('/orders/:correlationId', async (req, res, next) => {
  try {
    const record = await findWaitingOrder(req.params.correlationId!);
    res.json(buildOutboundJson(record.correlationId, record.currentAttempt, record.header));
  } catch (err) {
    next(err);
  }
});

/**
 * The very file the folder drop writes for this order, for a SAP job that reads CSV and has no
 * shared folder to read it from (the hosted Business Command Centre has none). Built by the same function with
 * the same CSV_* settings, so the bytes are the ones the folder would hold. When the Business Command Centre is
 * set to write a header file and a lines file, ?file=H or ?file=L picks which one.
 */
sapApiRouter.get('/orders/:correlationId/csv', async (req, res, next) => {
  try {
    const { file } = z.object({ file: z.enum(['H', 'L']).optional() }).parse(req.query);
    const record = await findWaitingOrder(req.params.correlationId!);

    sendOrderCsv(res, record, file);
  } catch (err) {
    next(err);
  }
});

/**
 * A fixed test file, served with the very bytes it was saved with, so SAP's own program can be tried
 * against the file its developer wrote (the Business Command Centre cannot write every such file from a PO). Only
 * .csv files that sit directly in backend/test-files, asked for by a plain name: no folders, no "..".
 * It is behind the same key and address list as everything else here.
 */
const testFilesDir = fileURLToPath(new URL('../../../test-files/', import.meta.url));
const TEST_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.csv$/;

sapApiRouter.get('/test-files/:name', async (req, res, next) => {
  try {
    const name = req.params.name!;
    if (!TEST_FILE_NAME.test(name)) throw notFound('No such test file.');
    let content: Buffer;
    try {
      content = await fs.readFile(path.join(testFilesDir, name));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') throw notFound('No such test file.');
      throw err;
    }
    res.type('text/csv');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(content);
  } catch (err) {
    next(err);
  }
});

/**
 * ABAP's JSON serialisers write field names in capitals with underscores (CORRELATION_ID);
 * other callers write camelCase. Both are accepted, so SAP does not have to rename anything.
 */
const squash = (o: unknown): unknown =>
  o && typeof o === 'object' && !Array.isArray(o)
    ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k.replace(/_/g, '').toLowerCase(), v]))
    : o;

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

const resultBody = z
  .object({
    correlationid: z.string().trim().min(1, 'correlationId is required').max(100),
    attempt: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number().int().positive().optional()),
    status: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(['SUCCESS', 'ERROR'])),
    sonumber: optionalText(20),
    errorcode: optionalText(100),
    errormessage: optionalText(2000),
    saptimestamp: optionalText(40),
  })
  .refine((b) => b.status !== 'SUCCESS' || !!b.sonumber, {
    message: 'A SUCCESS answer must carry soNumber.',
    path: ['soNumber'],
  });

/** What SAP is told about an answer it posted, whichever of the two result addresses it used. */
function respondTo(res: Response, outcome: Awaited<ReturnType<typeof ingestApiResult>>, correlationId: string): void {
  switch (outcome) {
    case 'applied':
    case 'applied-late':
      return void res.json({ accepted: true, applied: true, outcome });
    case 'duplicate':
      // The same answer again: nothing to do, and nothing wrong. SAP can stop retrying.
      return void res.json({ accepted: true, applied: false, duplicate: true });
    case 'unmatched':
      throw new AppError(404, `No order has correlation ID ${correlationId}.`, 'UNKNOWN_CORRELATION_ID');
    case 'ignored-stale':
      throw new AppError(409, 'That answer is for an earlier attempt of this order, so it was kept on file but not applied.', 'STALE_ATTEMPT');
    case 'ignored-not-waiting':
      throw new AppError(409, 'That order is not waiting for an answer, so this one was kept on file but not applied.', 'NOT_WAITING_FOR_RESULT');
  }
}

sapApiRouter.post('/results', requireJsonBody, async (req, res, next) => {
  try {
    const b = resultBody.parse(squash(req.body));
    const outcome = await ingestApiResult({
      correlationId: b.correlationid,
      attempt: b.attempt ?? null,
      outcome: b.status,
      soNumber: b.sonumber ?? null,
      errorCode: b.errorcode ?? null,
      errorMessage: b.errormessage ?? null,
      sapTimestamp: b.saptimestamp ?? null,
    });
    respondTo(res, outcome, b.correlationid);
  } catch (err) {
    next(err);
  }
});

/**
 * The short form of a success, for a SAP job whose answer is only the Sales Order number. The order
 * is named by the URL, never guessed from the number: SAP already holds the correlation ID from
 * GET /orders. Failures still go to POST /results, because they need a code and a reason.
 *
 * The body can be JSON ({"VBELN":"…"}), form fields (VBELN=…) or the number alone as plain text;
 * the JSON parser has already run by here, so only the other two are added.
 */
sapApiRouter.post(
  '/orders/:correlationId/result',
  express.urlencoded({ extended: false, limit: '10kb' }),
  express.text({ type: 'text/*', limit: '10kb' }),
  async (req, res, next) => {
    try {
      const correlationId = req.params.correlationId!;
      let soNumber: string;
      try {
        soNumber = soNumberFromBody(req.body);
      } catch (err) {
        if (err instanceof VbelnError) throw badRequest(err.message, 'VALIDATION_ERROR');
        throw err;
      }

      // The order's own attempt, so a repeat is recognised for that attempt and a late answer for
      // an earlier one is not mistaken for it. An unknown ID goes on with no attempt and comes back
      // as `unmatched`, which keeps the answer on file and tells Operations (FR-10.6).
      const order = await prisma.pORecord.findFirst({
        where: { correlationId, deletedAt: null },
        select: { currentAttempt: true },
      });
      const outcome = await ingestApiResult({
        correlationId,
        attempt: order?.currentAttempt ?? null,
        outcome: 'SUCCESS',
        soNumber,
        errorCode: null,
        errorMessage: null,
        sapTimestamp: null,
      });
      respondTo(res, outcome, correlationId);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * One address, for a SAP job that can use only one link and so cannot put an order ID in the path.
 *
 * GET  returns the oldest order still waiting for SAP as its CSV (the ID is in X-Correlation-Id and in the file
 *      name), or the one with ?po=<PO number>. An order stays the answer until its number is posted.
 * POST takes {"PO_NUMBER":"…","VBELN":"…"} and records the number as the answer to the one order waiting
 *      under that PO number. Nothing is guessed: no match is a 404, and two orders under one PO number are a 409,
 *      and in both the answer is kept on file and Operations is told.
 *
 * A PO number of exactly ten characters that matches nothing is tried as the start of a longer one, because a
 * CHAR10 field on the SAP side cuts longer numbers (LEM-26-04417 arrives as LEM-26-044).
 */
const WAITING = WAITING_FOR_SAP;

sapApiRouter.get('/po', async (req, res, next) => {
  try {
    const { po, file } = z
      .object({ po: z.string().trim().min(1).max(35).optional(), file: z.enum(['H', 'L']).optional() })
      .parse(req.query);
    const record = await prisma.pORecord.findFirst({
      where: {
        deletedAt: null,
        OR: WAITING_FOR_SAP,
        ...(po ? { header: { is: { poNumber: { equals: po, mode: 'insensitive' as const } } } } : {}),
      },
      orderBy: { sentToSapAt: 'asc' },
      include: recordWithLines,
    });
    if (!record || !record.header) {
      throw new AppError(404, po ? `No order waiting for SAP has PO number ${po}.` : 'No order is waiting for SAP.', 'NO_ORDER_WAITING');
    }
    sendOrderCsv(res, { ...record, header: record.header }, file);
  } catch (err) {
    next(err);
  }
});

/**
 * SAP's answer to /po as fields. It may be JSON, form fields, or the text its job writes: an optional
 * "sales_order:" and then the PO number (CHAR10, so padded with spaces when shorter) and the Sales Order
 * number (VBELN, CHAR10) joined with nothing between, as in "sales_order:61000000190010002525". In that
 * last form the Sales Order is the last ten characters and the PO number is everything before them.
 */
function poAnswerFields(body: unknown): unknown {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : null;
  if (text === null) return body;
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t);
    } catch {
      throw badRequest('The body starts like JSON but is not valid JSON. Send {"PO_NUMBER":"6100000019","VBELN":"4500387184"}.', 'VALIDATION_ERROR');
    }
  }
  if (/^[^=\s:]+=/.test(t)) return Object.fromEntries(new URLSearchParams(t));
  const joined = t.replace(/^sales_order\s*[:=]\s*/i, '').trimEnd();
  if (joined.length > 10) return { PO_NUMBER: joined.slice(0, -10).trim(), VBELN: joined.slice(-10) };
  return {};
}

sapApiRouter.post('/po', async (req, res, next) => {
  try {
    const answer = poAnswerFields(req.body);
    const fields = squash(answer) as Record<string, unknown> | undefined;
    const rawPo = fields && typeof fields === 'object' ? (fields.ponumber ?? fields.ebeln) : undefined;
    const po = typeof rawPo === 'string' || typeof rawPo === 'number' ? String(rawPo).trim() : '';
    if (!po || po.length > 35) {
      throw badRequest('PO_NUMBER is required (up to 35 characters). Send {"PO_NUMBER":"6100000019","VBELN":"4500387184"}.', 'VALIDATION_ERROR');
    }
    let soNumber: string;
    try {
      soNumber = soNumberFromBody(answer);
    } catch (err) {
      if (err instanceof VbelnError) throw badRequest(err.message, 'VALIDATION_ERROR');
      throw err;
    }

    const find = (poNumber: { equals: string; mode: 'insensitive' } | { startsWith: string; mode: 'insensitive' }) =>
      prisma.pORecord.findMany({
        where: { deletedAt: null, OR: [...WAITING], header: { is: { poNumber } } },
        select: { correlationId: true, currentAttempt: true },
        take: 5,
      });
    let matches = await find({ equals: po, mode: 'insensitive' });
    if (matches.length === 0 && po.length === 10) matches = await find({ startsWith: po, mode: 'insensitive' });

    if (matches.length !== 1) {
      // Kept on file and Operations told, like an answer for an unknown order ID (FR-10.6).
      await ingestApiResult({
        correlationId: `PO#${po}`, attempt: null, outcome: 'SUCCESS', soNumber, errorCode: null, errorMessage: null, sapTimestamp: null,
      });
      if (matches.length === 0) {
        throw new AppError(404, `No order waiting for SAP has PO number ${po}. The answer was kept on file and our operations team is alerted.`, 'UNKNOWN_PO_NUMBER');
      }
      throw conflict(`${matches.length} orders waiting for SAP have PO number ${po}, so the answer was not applied. It was kept on file and our operations team is alerted.`, 'AMBIGUOUS_PO_NUMBER', { orders: matches.length });
    }

    const order = matches[0]!;
    const outcome = await ingestApiResult({
      correlationId: order.correlationId, attempt: order.currentAttempt, outcome: 'SUCCESS', soNumber, errorCode: null, errorMessage: null, sapTimestamp: null,
    });
    respondTo(res, outcome, order.correlationId);
  } catch (err) {
    next(err);
  }
});
