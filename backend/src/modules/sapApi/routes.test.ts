import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What SAP sees and what it can do: fetch the orders waiting for it, and post an answer that is
// handled by the same rules as a result file. The rules themselves are tested with the watcher;
// here the question is what each call returns.

const KEY = 'sap-test-key-0123456789-abcdefghij';

let records: Record<string, unknown>[] = [];
const prismaMock = {
  pORecord: {
    findMany: vi.fn(async () => records),
    findFirst: vi.fn(async (args: { where: { correlationId: string } }) => records.find((r) => r.correlationId === args.where.correlationId) ?? null),
  },
};
const ingest = vi.fn();
vi.mock('../../db/client.js', () => ({ prisma: prismaMock }));
vi.mock('../../services/sap/resultWatcher.js', () => ({ ingestApiResult: (...a: unknown[]) => ingest(...a) }));

async function makeApp() {
  process.env.SAP_API_KEY = KEY;
  vi.resetModules();
  const { sapApiRouter } = await import('./routes.js');
  const { errorHandler } = await import('../../middleware/error.js');
  const app = express();
  app.use('/sap/po', express.raw({ type: () => true, limit: '10kb' })); // as in app.ts
  app.use(express.json());
  app.use('/sap', sapApiRouter);
  app.use(errorHandler);
  return app;
}
const get = (app: express.Express, path: string) => request(app).get(`/sap${path}`).set('X-API-Key', KEY);
const post = (app: express.Express, path: string, body: unknown) => request(app).post(`/sap${path}`).set('X-API-Key', KEY).send(body as object);

const record = (over: Record<string, unknown> = {}) => ({
  id: 'r1', correlationId: 'PO-AAA', status: 'SENT_TO_SAP', currentAttempt: 1, sentToSapAt: new Date(),
  header: {
    poNumber: 'APX-1', poDate: 'Sep 18, 2026', customerCode: 'C-1', customerName: 'Apex', shipTo: 'Dock 4', billTo: null,
    currency: 'usd ', requestedDeliveryDate: '18/10/2026', paymentTerms: 'Net 30', incoterms: 'FOB', poTotalValue: '1.234,56',
    lineItems: [
      { lineNumber: 2, materialCode: 'M-2', customerMaterialNumber: null, description: 'Bolt', quantity: '10', uom: 'EA', unitPrice: '1,50', lineNetValue: '15,00', deliveryDate: null, plant: '1000' },
      { lineNumber: 1, materialCode: 'M-1', customerMaterialNumber: 'X9', description: 'Nut', quantity: '1000', uom: 'EA', unitPrice: '1.219,56', lineNetValue: '1.219,56', deliveryDate: '20 Oct 2026', plant: '1000' },
    ],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  records = [];
});

describe('the single address, /po (for a SAP job that can use only one link)', () => {
  const waiting = (over: Record<string, unknown> = {}) => ({ correlationId: 'PO-AAA', currentAttempt: 1, ...over });
  const answer = { PO_NUMBER: 'APX-1', VBELN: '0010002504' };
  const asked = () => ({ correlationId: 'PO-AAA', attempt: 1, outcome: 'SUCCESS', soNumber: '0010002504', errorCode: null, errorMessage: null, sapTimestamp: null });

  it('needs the key, for both methods', async () => {
    const app = await makeApp();
    expect((await request(app).get('/sap/po')).status).toBe(401);
    expect((await request(app).post('/sap/po').send(answer)).status).toBe(401);
  });

  it('GET returns the oldest waiting order as its CSV, with the order ID in a header', async () => {
    prismaMock.pORecord.findFirst.mockResolvedValueOnce(record());
    const res = await get(await makeApp(), '/po');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['x-correlation-id']).toBe('PO-AAA');
    expect(res.headers['content-disposition']).toBe('attachment; filename="PO_PO-AAA_1.csv"');
    expect(res.text).toContain('H,PO-AAA,1,APX-1,2026-09-18');
    const where = prismaMock.pORecord.findFirst.mock.calls.at(-1)![0] as unknown as { where: Record<string, unknown>; orderBy: unknown };
    expect(where.where).toMatchObject({ status: 'SENT_TO_SAP', deletedAt: null });
    expect(where.orderBy).toEqual({ sentToSapAt: 'asc' });
  });

  it('GET ?po= picks the waiting order with that PO number', async () => {
    prismaMock.pORecord.findFirst.mockResolvedValueOnce(record());
    await get(await makeApp(), '/po?po=APX-1');
    const call = prismaMock.pORecord.findFirst.mock.calls.at(-1)![0] as unknown as { where: { header: unknown } };
    expect(call.where.header).toEqual({ is: { poNumber: { equals: 'APX-1', mode: 'insensitive' } } });
  });

  it('GET says plainly when nothing is waiting', async () => {
    prismaMock.pORecord.findFirst.mockResolvedValueOnce(null);
    const res = await get(await makeApp(), '/po');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_ORDER_WAITING');
  });

  it('POST applies the number to the one order waiting under that PO number', async () => {
    prismaMock.pORecord.findMany.mockResolvedValueOnce([waiting()]);
    ingest.mockResolvedValue('applied');
    const res = await post(await makeApp(), '/po', answer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, applied: true, outcome: 'applied' });
    expect(ingest).toHaveBeenCalledWith(asked());
  });

  it('POST takes the answer in ABAP-style names or as form fields, and the order\'s own attempt', async () => {
    prismaMock.pORecord.findMany.mockResolvedValue([waiting({ currentAttempt: 3 })]);
    ingest.mockResolvedValue('applied');
    const app = await makeApp();
    expect((await request(app).post('/sap/po').set('X-API-Key', KEY).type('form').send({ po_number: 'APX-1', vbeln: '0010002504' })).status).toBe(200);
    expect(ingest).toHaveBeenCalledWith({ ...asked(), attempt: 3 });
    prismaMock.pORecord.findMany.mockImplementation(async () => records);
  });

  it('POST reads the text SAP\'s job writes, sales_order:<PO 10><SO 10>, even under a JSON Content-Type', async () => {
    prismaMock.pORecord.findMany.mockResolvedValue([waiting()]);
    ingest.mockResolvedValue('applied');
    const app = await makeApp();
    const send = (body: string) => request(app).post('/sap/po').set('X-API-Key', KEY).set('Content-Type', 'application/json; charset=utf-8').send(body);

    expect((await send('sales_order:61000000190010002525 ')).status).toBe(200);
    expect(prismaMock.pORecord.findMany.mock.calls.at(-1)).toBeDefined();
    const where = (prismaMock.pORecord.findMany.mock.calls as unknown as [{ where: { header: unknown } }][]).at(-1)![0].where;
    expect(where.header).toEqual({ is: { poNumber: { equals: '6100000019', mode: 'insensitive' } } });
    expect(ingest).toHaveBeenLastCalledWith({ ...asked(), soNumber: '0010002525' });

    // A PO number shorter than ten characters is padded with spaces in a CHAR10, and the prefix is optional.
    expect((await send('sales_order:NW-884213 0010002526 ')).status).toBe(200);
    const padded = (prismaMock.pORecord.findMany.mock.calls as unknown as [{ where: { header: unknown } }][]).at(-1)![0].where;
    expect(padded.header).toEqual({ is: { poNumber: { equals: 'NW-884213', mode: 'insensitive' } } });
    expect(ingest).toHaveBeenLastCalledWith({ ...asked(), soNumber: '0010002526' });
    expect((await send('61000000190010002527')).status).toBe(200);
    expect(ingest).toHaveBeenLastCalledWith({ ...asked(), soNumber: '0010002527' });

    // A body too short to hold both numbers is refused, and nothing is touched.
    ingest.mockClear();
    const short = await send('sales_order:0010002525');
    expect(short.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    prismaMock.pORecord.findMany.mockImplementation(async () => records);
  });

  it('POST: a PO number SAP cut to ten characters is tried as the start of a longer one', async () => {
    prismaMock.pORecord.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([waiting()]);
    ingest.mockResolvedValue('applied');
    const res = await post(await makeApp(), '/po', { PO_NUMBER: 'LEM-26-044', VBELN: '0010002504' });
    expect(res.status).toBe(200);
    expect(prismaMock.pORecord.findMany).toHaveBeenCalledTimes(2);
    const second = (prismaMock.pORecord.findMany.mock.calls as unknown as [{ where: { header: unknown } }][])[1]![0];
    expect(second.where.header).toEqual({ is: { poNumber: { startsWith: 'LEM-26-044', mode: 'insensitive' } } });
    expect(ingest).toHaveBeenCalledWith(asked());
  });

  it('POST: no order under that PO number is a 404, kept on file for Operations, nothing applied', async () => {
    prismaMock.pORecord.findMany.mockResolvedValueOnce([]);
    ingest.mockResolvedValue('unmatched');
    const res = await post(await makeApp(), '/po', { PO_NUMBER: 'NO-SUCH-PO-1', VBELN: '0010002504' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_PO_NUMBER');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'PO#NO-SUCH-PO-1', soNumber: '0010002504' }));
  });

  it('POST: two orders under one PO number are a 409, never a guess', async () => {
    prismaMock.pORecord.findMany.mockResolvedValueOnce([waiting(), waiting({ correlationId: 'PO-BBB' })]);
    ingest.mockResolvedValue('unmatched');
    const res = await post(await makeApp(), '/po', answer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AMBIGUOUS_PO_NUMBER');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'PO#APX-1' }));
  });

  it('POST refuses a missing PO number or a bad sales order number without touching anything', async () => {
    const app = await makeApp();
    const noPo = await post(app, '/po', { VBELN: '0010002504' });
    expect(noPo.status).toBe(400);
    expect(noPo.body.error.code).toBe('VALIDATION_ERROR');
    const badSo = await post(app, '/po', { PO_NUMBER: 'APX-1', VBELN: 'sales_order:0010002504' });
    expect(badSo.status).toBe(400);
    const none = await post(app, '/po', { PO_NUMBER: 'APX-1' });
    expect(none.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('GET /test-files/:name', () => {
  const file = (name: string) => fileURLToPath(new URL(`../../../test-files/${name}`, import.meta.url));

  it('needs the key', async () => {
    const app = await makeApp();
    expect((await request(app).get('/sap/test-files/SAP_PO_test3.csv')).status).toBe(401);
  });

  it('serves the SAP team\'s file with the bytes it was saved with', async () => {
    const app = await makeApp();
    const res = await get(app, '/test-files/SAP_PO_test3.csv').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="SAP_PO_test3.csv"');
    expect(Buffer.compare(res.body as Buffer, readFileSync(file('SAP_PO_test3.csv')))).toBe(0);
    expect((res.body as Buffer).toString('utf8')).toMatch(/^PO_NUMBER,COMPANY_CODE,DOC_TYPE,/);
  });

  it('answers 404 for a missing file, another type, and any path trick', async () => {
    const app = await makeApp();
    for (const name of ['missing.csv', 'SAP_PO_test3.txt', '..%2fpackage.json', '..%2f..%2fsrc%2fapp.ts', '%2e%2e%2fSAP_PO_test3.csv', 'a%2fb.csv', '.hidden.csv']) {
      const res = await get(app, `/test-files/${name}`);
      expect(res.status, name).toBe(404);
    }
  });
});

describe('GET /orders', () => {
  it('needs the key', async () => {
    const app = await makeApp();
    expect((await request(app).get('/sap/orders')).status).toBe(401);
  });

  it('lists the orders waiting for SAP, in the same formats as the file: ISO dates, "." decimals, lines in order', async () => {
    records = [record()];
    const res = await get(await makeApp(), '/orders');
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    const o = res.body.orders[0];
    expect(o).toMatchObject({ correlationId: 'PO-AAA', attempt: 1 });
    expect(o.header).toMatchObject({
      poNumber: 'APX-1', poDate: '2026-09-18', requestedDeliveryDate: '2026-10-18', currency: 'USD', poTotalValue: '1234.56',
    });
    expect(o.lines.map((l: { lineNumber: number }) => l.lineNumber)).toEqual([1, 2]);
    expect(o.lines[0]).toMatchObject({ quantity: '1000', unitPrice: '1219.56', deliveryDate: '2026-10-20', customerMaterialNumber: 'X9' });
    expect(o.lines[1]).toMatchObject({ quantity: '10', unitPrice: '1.50', deliveryDate: '' });
  });

  it('asks only for orders that are with SAP', async () => {
    await get(await makeApp(), '/orders?limit=5');
    expect(prismaMock.pORecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'SENT_TO_SAP', deletedAt: null }, take: 5 }),
    );
  });

  it('reports an order it cannot write instead of hiding it, and still returns the rest', async () => {
    const bad = record({ correlationId: 'PO-BAD' });
    (bad.header as { poDate: string }).poDate = 'sometime soon';
    records = [bad, record()];
    const res = await get(await makeApp(), '/orders');
    expect(res.body.orders.map((o: { correlationId: string }) => o.correlationId)).toEqual(['PO-AAA']);
    expect(res.body.problems).toEqual([{ correlationId: 'PO-BAD', error: expect.stringContaining('not a valid date') }]);
  });

  it('rejects a silly limit', async () => {
    expect((await get(await makeApp(), '/orders?limit=0')).status).toBe(400);
    expect((await get(await makeApp(), '/orders?limit=500')).status).toBe(400);
  });
});

describe('GET /orders/:correlationId', () => {
  it('returns one order', async () => {
    records = [record()];
    const res = await get(await makeApp(), '/orders/PO-AAA');
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('PO-AAA');
  });
  it('404 for one that does not exist, and 409 for one that is not waiting for SAP', async () => {
    records = [record({ correlationId: 'PO-DONE', status: 'SO_CREATED' })];
    const app = await makeApp();
    expect((await get(app, '/orders/PO-NOPE')).status).toBe(404);
    const done = await get(app, '/orders/PO-DONE');
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('NOT_WAITING_FOR_SAP');
  });
});

describe('GET /orders/:correlationId/csv', () => {
  const HEADER_ROW = 'H,PO-AAA,1,APX-1,2026-09-18,C-1,Apex,Dock 4,,USD,2026-10-18,Net 30,FOB,1234.56';
  const LINE_1 = 'L,PO-AAA,1,1,M-1,X9,Nut,1000,EA,1219.56,1219.56,2026-10-20,1000';
  const LINE_2 = 'L,PO-AAA,1,2,M-2,,Bolt,10,EA,1.50,15.00,,1000';

  it('needs the key', async () => {
    expect((await request(await makeApp()).get('/sap/orders/PO-AAA/csv')).status).toBe(401);
  });

  it('sends the file the folder drop would write: one H row, then one L row per line, in the same formats', async () => {
    records = [record()];
    const res = await get(await makeApp(), '/orders/PO-AAA/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="PO_PO-AAA_1.csv"');
    expect(res.text).toBe([HEADER_ROW, LINE_1, LINE_2, ''].join('\n'));
  });

  it('is the same file the JSON list describes', async () => {
    records = [record()];
    const app = await makeApp();
    const csv = (await get(app, '/orders/PO-AAA/csv')).text;
    const json = (await get(app, '/orders/PO-AAA')).body;
    expect(csv.split('\n')[0]).toContain(`,${json.header.poNumber},${json.header.poDate},`);
    expect(csv.split('\n')).toHaveLength(json.lines.length + 2);
  });

  it('404 for an order that does not exist, 409 for one that is not waiting for SAP', async () => {
    records = [record({ correlationId: 'PO-DONE', status: 'SO_CREATED' })];
    const app = await makeApp();
    expect((await get(app, '/orders/PO-NOPE/csv')).status).toBe(404);
    const done = await get(app, '/orders/PO-DONE/csv');
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('NOT_WAITING_FOR_SAP');
  });

  it('422 with the reason when a value cannot be written, rather than sending a guess', async () => {
    const bad = record();
    (bad.header as { poDate: string }).poDate = 'sometime soon';
    records = [bad];
    const res = await get(await makeApp(), '/orders/PO-AAA/csv');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_NOT_WRITABLE');
    expect(res.body.error.message).toContain('not a valid date');
  });

  describe('when the Business Command Centre writes a header file and a lines file', () => {
    beforeEach(() => {
      process.env.CSV_LAYOUT = 'header_lines_pair';
    });
    afterEach(() => {
      delete process.env.CSV_LAYOUT;
    });

    it('asks which one, then sends each under the name the folder drop gives it', async () => {
      records = [record()];
      const app = await makeApp();

      const either = await get(app, '/orders/PO-AAA/csv');
      expect(either.status).toBe(400);
      expect(either.body.error.code).toBe('FILE_REQUIRED');

      const h = await get(app, '/orders/PO-AAA/csv?file=H');
      expect(h.headers['content-disposition']).toBe('attachment; filename="PO_PO-AAA_1_H.csv"');
      expect(h.text).toBe([HEADER_ROW, ''].join('\n'));

      const l = await get(app, '/orders/PO-AAA/csv?file=L');
      expect(l.headers['content-disposition']).toBe('attachment; filename="PO_PO-AAA_1_L.csv"');
      expect(l.text).toBe([LINE_1, LINE_2, ''].join('\n'));
    });

    it('rejects a file other than H or L', async () => {
      records = [record()];
      expect((await get(await makeApp(), '/orders/PO-AAA/csv?file=X')).status).toBe(400);
    });
  });
});

describe('POST /orders/:correlationId/result (the answer that is only the Sales Order number)', () => {
  const url = '/sap/orders/PO-AAA/result';
  const withKey = (r: request.Test) => r.set('X-API-Key', KEY);
  const expectedCall = (over: Record<string, unknown> = {}) => ({
    correlationId: 'PO-AAA', attempt: 1, outcome: 'SUCCESS', soNumber: '4500387184', errorCode: null, errorMessage: null, sapTimestamp: null, ...over,
  });

  it('needs the key', async () => {
    expect((await request(await makeApp()).post(url).send({ VBELN: '4500387184' })).status).toBe(401);
  });

  it('applies a success named by the URL, from a JSON body of just VBELN', async () => {
    records = [record({ currentAttempt: 2 })];
    ingest.mockResolvedValue('applied');
    const res = await withKey(request(await makeApp()).post(url)).send({ VBELN: '4500387184' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, applied: true, outcome: 'applied' });
    // The order's own attempt goes with it, so a repeat is recognised for that attempt.
    expect(ingest).toHaveBeenCalledWith(expectedCall({ attempt: 2 }));
  });

  it('takes the same number as a form field or as plain text', async () => {
    records = [record()];
    ingest.mockResolvedValue('applied');
    const app = await makeApp();
    expect((await withKey(request(app).post(url)).type('form').send({ VBELN: '4500387184' })).status).toBe(200);
    expect((await withKey(request(app).post(url)).type('form').send({ sales_orders: '4500387184' })).status).toBe(200);
    expect((await withKey(request(app).post(url)).set('Content-Type', 'text/plain').send('4500387184\r\n')).status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(3);
    for (const call of ingest.mock.calls) expect(call[0]).toEqual(expectedCall());
  });

  it('refuses a body with no number, or with more than one, without touching any order', async () => {
    records = [record()];
    const app = await makeApp();
    const none = await withKey(request(app).post(url)).send({});
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');
    expect(none.body.error.message).toContain('No Sales Order number');

    const many = await withKey(request(app).post(url)).send({ VBELN: '4500387184,4500387185' });
    expect(many.status).toBe(400);
    expect(many.body.error.message).toContain('not a Sales Order number');

    expect((await withKey(request(app).post(url)).set('Content-Type', 'text/plain').send('hello there')).status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('keeps an answer for an unknown ID on file and says so, the same as /results', async () => {
    ingest.mockResolvedValue('unmatched');
    const res = await withKey(request(await makeApp()).post('/sap/orders/PO-NOPE/result')).send({ VBELN: '4500387184' });
    expect(res).toMatchObject({ status: 404, body: { error: { code: 'UNKNOWN_CORRELATION_ID' } } });
    expect(ingest).toHaveBeenCalledWith(expectedCall({ correlationId: 'PO-NOPE', attempt: null }));
  });

  it('answers a repeat, a stale answer and an order not waiting exactly as /results does', async () => {
    records = [record()];
    const app = await makeApp();
    const send = () => withKey(request(app).post(url)).send({ VBELN: '4500387184' });
    ingest.mockResolvedValueOnce('duplicate');
    expect(await send()).toMatchObject({ status: 200, body: { accepted: true, applied: false, duplicate: true } });
    ingest.mockResolvedValueOnce('ignored-stale');
    expect(await send()).toMatchObject({ status: 409, body: { error: { code: 'STALE_ATTEMPT' } } });
    ingest.mockResolvedValueOnce('ignored-not-waiting');
    expect(await send()).toMatchObject({ status: 409, body: { error: { code: 'NOT_WAITING_FOR_RESULT' } } });
  });
});

describe('POST /results', () => {
  it('applies a success and says so', async () => {
    ingest.mockResolvedValue('applied');
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, applied: true, outcome: 'applied' });
    expect(ingest).toHaveBeenCalledWith({
      correlationId: 'PO-AAA', attempt: 1, outcome: 'SUCCESS', soNumber: '4500123456', errorCode: null, errorMessage: null, sapTimestamp: null,
    });
  });

  it('understands ABAP-style field names and any case of the status', async () => {
    ingest.mockResolvedValue('applied');
    const res = await post(await makeApp(), '/results', {
      CORRELATION_ID: 'PO-AAA', ATTEMPT: '2', STATUS: 'error', ERROR_CODE: 'PRICING_ERROR', ERROR_MESSAGE: 'No condition record', SAP_TIMESTAMP: '2026-10-05T10:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith({
      correlationId: 'PO-AAA', attempt: 2, outcome: 'ERROR', soNumber: null, errorCode: 'PRICING_ERROR', errorMessage: 'No condition record', sapTimestamp: '2026-10-05T10:00:00Z',
    });
  });

  it('refuses a success with no Sales Order number, the same as a result file', async () => {
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', status: 'SUCCESS' });
    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('refuses a body with no correlation ID or an unknown status', async () => {
    const app = await makeApp();
    expect((await post(app, '/results', { status: 'ERROR' })).status).toBe(400);
    expect((await post(app, '/results', { correlationId: 'PO-AAA', status: 'MAYBE' })).status).toBe(400);
  });

  it('treats the same answer sent twice as done, not as a problem', async () => {
    ingest.mockResolvedValue('duplicate');
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, applied: false, duplicate: true });
  });

  it('says plainly when an answer was kept but not applied, or matches nothing', async () => {
    const app = await makeApp();
    const body = { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' };
    ingest.mockResolvedValueOnce('ignored-stale');
    expect(await post(app, '/results', body)).toMatchObject({ status: 409, body: { error: { code: 'STALE_ATTEMPT' } } });
    ingest.mockResolvedValueOnce('ignored-not-waiting');
    expect(await post(app, '/results', body)).toMatchObject({ status: 409, body: { error: { code: 'NOT_WAITING_FOR_RESULT' } } });
    ingest.mockResolvedValueOnce('unmatched');
    expect(await post(app, '/results', body)).toMatchObject({ status: 404, body: { error: { code: 'UNKNOWN_CORRELATION_ID' } } });
  });

  it('applies a late answer the same way as an ordinary one', async () => {
    ingest.mockResolvedValue('applied-late');
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' });
    expect(res.body).toMatchObject({ applied: true, outcome: 'applied-late' });
  });
});

describe('GET /ping', () => {
  it('answers when the key is right and touches no order', async () => {
    const res = await get(await makeApp(), '/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.pORecord.findMany).not.toHaveBeenCalled();
  });
});
