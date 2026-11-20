import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntakeOutcome } from '@prisma/client';

// The intake's rules, with a fake mailbox and a fake database: which mails become records, which are
// set aside for a person, and that a mail is never imported twice however a pass is interrupted.

vi.mock('../../db/client.js', () => ({ prisma: {} }));

const { runMailIntakeOnce, senderAllowed } = await import('./intake.js');
import type { IntakeDeps } from './intake.js';
import type { MailAttachment, MailDestination, MailMessage, MailSource } from './source.js';

const PDF = (text: string) => Buffer.from(`%PDF-1.4\n${text}`);
const pdf = (name: string, text = name): MailAttachment => ({ name, contentType: 'application/pdf', size: 100, content: PDF(text) });

let n = 0;
const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: `g${++n}`,
  internetMessageId: `<m${n}@customer.example>`,
  subject: 'PO 4711',
  fromAddress: 'buyer@customer.example',
  fromName: 'A Buyer',
  receivedAt: new Date('2026-11-20T09:00:00Z'),
  ...over,
});

class FakeMailbox implements MailSource {
  moved: [string, MailDestination][] = [];
  failMove = false;
  constructor(
    public messages: MailMessage[],
    public attachments: Record<string, MailAttachment[]>,
  ) {}
  async listPending() {
    return this.messages;
  }
  async getAttachments(m: MailMessage) {
    return this.attachments[m.id] ?? [];
  }
  async moveTo(m: MailMessage, d: MailDestination) {
    if (this.failMove) throw new Error('Graph is down');
    this.moved.push([m.id, d]);
  }
}

/** An in-memory stand-in for the IntakeEmail table and the records service. */
function fakeDb() {
  const emails = new Map<string, { id: string; outcome: IntakeOutcome; detail: string | null; hashes: string[] }>();
  const records: { recordId: string; emailId: string; name: string; hash: string }[] = [];
  const knownHashes = new Set<string>();
  let failCreate = false;
  const sha = async (b: Buffer) => (await import('node:crypto')).createHash('sha256').update(b).digest('hex');

  const deps: IntakeDeps = {
    findEmail: async (imid) => {
      const e = emails.get(imid);
      return e ? { id: e.id, outcome: e.outcome, contentHashes: e.hashes } : null;
    },
    saveEmail: async (m, outcome, detail, existingId) => {
      const e = emails.get(m.internetMessageId) ?? { id: existingId ?? `e-${m.id}`, outcome, detail, hashes: [] };
      Object.assign(e, { outcome, detail });
      emails.set(m.internetMessageId, e);
      return { id: e.id };
    },
    createRecord: async (file, _notes, emailId) => {
      if (failCreate) throw new Error('database unavailable');
      const hash = await sha(file.buffer);
      const duplicates = knownHashes.has(hash) ? 1 : 0;
      knownHashes.add(hash);
      const recordId = `r${records.length + 1}`;
      records.push({ recordId, emailId, name: file.originalname, hash });
      for (const e of emails.values()) if (e.id === emailId) e.hashes.push(hash);
      return { recordId, correlationId: `PO-${recordId.toUpperCase()}`, duplicates };
    },
    publish: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    notifyReceived: vi.fn(async () => {}),
  };
  return {
    deps,
    emails,
    records,
    failCreate: (v: boolean) => (failCreate = v),
  };
}

const opts = { allowedSenders: '', maxBytes: 20 * 1024 * 1024 };

beforeEach(() => {
  n = 0;
});

describe('senderAllowed', () => {
  it('allows anyone when the list is empty', () => {
    expect(senderAllowed('x@y.z', '')).toBe(true);
  });
  it('matches whole addresses and domains, ignoring case and spaces', () => {
    const list = ' Pavan@Millennium.example , @customer.example, other.example';
    expect(senderAllowed('pavan@millennium.example', list)).toBe(true);
    expect(senderAllowed('someone@millennium.example', list)).toBe(false);
    expect(senderAllowed('BUYER@customer.example', list)).toBe(true);
    expect(senderAllowed('a@other.example', list)).toBe(true);
    expect(senderAllowed('a@sub.customer.example', list)).toBe(false);
    expect(senderAllowed('', list)).toBe(false);
  });
});

describe('runMailIntakeOnce', () => {
  it('turns each PDF in a mail into a record, publishes it, and files the mail as done', async () => {
    const m = mail();
    const box = new FakeMailbox([m], { [m.id]: [pdf('po-1.pdf'), pdf('po-2.pdf'), { name: 'logo.png', contentType: 'image/png', size: 3, content: Buffer.from('png') }] });
    const db = fakeDb();

    const [res] = await runMailIntakeOnce(box, db.deps, opts);

    expect(res).toMatchObject({ outcome: 'IMPORTED', records: ['PO-R1', 'PO-R2'] });
    expect(db.records.map((r) => r.name)).toEqual(['po-1.pdf', 'po-2.pdf']);
    expect(db.deps.publish).toHaveBeenCalledTimes(2);
    expect(db.deps.audit).toHaveBeenCalledTimes(2);
    expect(db.deps.notifyReceived).toHaveBeenCalledWith('e-g1', '2 POs received by email', expect.stringContaining('A Buyer <buyer@customer.example>: PO 4711'), null);
    expect(db.emails.get(m.internetMessageId)?.outcome).toBe('IMPORTED');
    expect(box.moved).toEqual([[m.id, 'done']]);
  });

  it('tells by content, not by name, what is a PDF', async () => {
    const m = mail();
    const box = new FakeMailbox([m], {
      [m.id]: [
        { name: 'scan.PDF', contentType: 'application/octet-stream', size: 9, content: PDF('x') },
        { name: 'fake.pdf', contentType: 'application/pdf', size: 9, content: Buffer.from('not a pdf') },
      ],
    });
    const db = fakeDb();
    await runMailIntakeOnce(box, db.deps, opts);
    expect(db.records.map((r) => r.name)).toEqual(['scan.PDF']);
  });

  it('sets aside a mail from a sender who is not allowed, without reading its attachments', async () => {
    const m = mail({ fromAddress: 'spam@elsewhere.example' });
    const box = new FakeMailbox([m], { [m.id]: [pdf('po.pdf')] });
    const getAttachments = vi.spyOn(box, 'getAttachments');
    const db = fakeDb();

    const [res] = await runMailIntakeOnce(box, db.deps, { ...opts, allowedSenders: '@customer.example' });

    expect(res?.outcome).toBe('SENDER_NOT_ALLOWED');
    expect(getAttachments).not.toHaveBeenCalled();
    expect(db.records).toHaveLength(0);
    expect(box.moved).toEqual([[m.id, 'attention']]);
  });

  it('sets aside a mail with no PDF, and says why', async () => {
    const a = mail();
    const b = mail();
    const box = new FakeMailbox([a, b], { [a.id]: [{ name: 'po.xlsx', contentType: 'x', size: 1, content: Buffer.from('PK') }] });
    const db = fakeDb();

    const results = await runMailIntakeOnce(box, db.deps, opts);

    expect(results.map((r) => r.outcome)).toEqual(['NO_PDF', 'NO_PDF']);
    expect(results[0]?.detail).toContain('po.xlsx');
    expect(results[1]?.detail).toBe('The mail has no attachments.');
    expect(box.moved).toEqual([
      [a.id, 'attention'],
      [b.id, 'attention'],
    ]);
  });

  it('says so when the only PDF was too large to import', async () => {
    const m = mail();
    const box = new FakeMailbox([m], { [m.id]: [{ name: 'huge.pdf', contentType: 'application/pdf', size: 9e8, content: null }] });
    const [res] = await runMailIntakeOnce(box, fakeDb().deps, opts);
    expect(res).toMatchObject({ outcome: 'NO_PDF', detail: expect.stringContaining('huge.pdf') });
  });

  it('leaves a PDF that was seen before as a draft, like a drag-and-drop upload', async () => {
    const a = mail();
    const b = mail();
    const box = new FakeMailbox([a, b], { [a.id]: [pdf('po.pdf', 'same')], [b.id]: [pdf('po-again.pdf', 'same')] });
    const db = fakeDb();

    const results = await runMailIntakeOnce(box, db.deps, opts);

    expect(db.deps.publish).toHaveBeenCalledTimes(1);
    expect(results[1]).toMatchObject({ outcome: 'IMPORTED', detail: expect.stringContaining('left as draft') });
  });

  it('keeps a record as a draft when publishing it is refused', async () => {
    const m = mail();
    const box = new FakeMailbox([m], { [m.id]: [pdf('po.pdf')] });
    const db = fakeDb();
    vi.mocked(db.deps.publish).mockRejectedValueOnce(new Error('DUPLICATE_DOCUMENT'));

    const [res] = await runMailIntakeOnce(box, db.deps, opts);

    expect(res).toMatchObject({ outcome: 'IMPORTED', detail: expect.stringContaining('left as draft') });
    expect(box.moved).toEqual([[m.id, 'done']]);
  });

  it('imports a mail once, even when it is still in the folder on the next pass', async () => {
    const m = mail();
    const box = new FakeMailbox([m], { [m.id]: [pdf('po.pdf')] });
    const db = fakeDb();

    box.failMove = true; // the records were made, but the mail could not be moved
    const first = await runMailIntakeOnce(box, db.deps, opts);
    expect(first[0]?.outcome).toBe('RETRY_LATER');
    expect(db.records).toHaveLength(1);

    box.failMove = false;
    const second = await runMailIntakeOnce(box, db.deps, opts);
    expect(second[0]?.outcome).toBe('ALREADY_DONE');
    expect(db.records).toHaveLength(1);
    expect(box.moved).toEqual([[m.id, 'done']]);
  });

  it('finishes a mail that failed half way without repeating the PDFs already imported', async () => {
    const m = mail();
    const box = new FakeMailbox([m], { [m.id]: [pdf('a.pdf'), pdf('b.pdf')] });
    const db = fakeDb();
    const create = db.deps.createRecord;
    let calls = 0;
    db.deps.createRecord = async (...args) => {
      if (++calls === 2) throw new Error('database unavailable');
      return create(...args);
    };

    const first = await runMailIntakeOnce(box, db.deps, opts);
    expect(first[0]?.outcome).toBe('RETRY_LATER');
    expect(box.moved).toEqual([]);
    expect(db.emails.get(m.internetMessageId)?.outcome).toBe('IMPORTING');

    const second = await runMailIntakeOnce(box, db.deps, opts);
    expect(second[0]).toMatchObject({ outcome: 'IMPORTED', records: ['PO-R2'] });
    expect(db.records.map((r) => r.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(box.moved).toEqual([[m.id, 'done']]);
  });

  it('carries on with the next mail when one fails', async () => {
    const a = mail();
    const b = mail();
    const box = new FakeMailbox([a, b], { [a.id]: [pdf('a.pdf')], [b.id]: [pdf('b.pdf')] });
    const db = fakeDb();
    db.failCreate(true);
    const create = db.deps.createRecord;
    db.deps.createRecord = async (file, ...rest) => {
      if (file.originalname === 'b.pdf') db.failCreate(false);
      return create(file, ...rest);
    };

    const results = await runMailIntakeOnce(box, db.deps, opts);
    expect(results.map((r) => r.outcome)).toEqual(['RETRY_LATER', 'IMPORTED']);
    expect(box.moved).toEqual([[b.id, 'done']]);
  });
});
