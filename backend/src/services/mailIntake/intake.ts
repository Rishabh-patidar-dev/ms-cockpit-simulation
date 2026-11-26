import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { IntakeOutcome } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { childLogger } from '../../lib/logger.js';
import { writeAudit } from '../audit.js';
import { notify, notifyIntegration } from '../notifications/notify.js';
import { createRecord, publishRecord, type Actor } from '../records.js';
import { detectDocument } from '../documents/index.js';
import { mailConnection, NOT_CONNECTED, storedTokens } from './delegated.js';
import { GraphMailSource, type MailMessage, type MailSource } from './source.js';

const log = childLogger('mail-intake');

/** The user every emailed PO is "uploaded by". It cannot sign in; an approver is always someone else. */
export const INTAKE_USER_EMAIL = 'email-intake@cockpit.local';
export const INTAKE_USER_NAME = 'Email intake';

/** The most PDFs taken from one mail, the same limit as one drag-and-drop upload. */
const MAX_PDFS_PER_MAIL = 50;

// ------------------------------------------------------------------ the rules

/**
 * Is this sender allowed to send POs? Entries are full addresses or domains ("@acme.com" or
 * "acme.com"). An empty list allows anyone, which suits a demo and nothing else.
 */
export function senderAllowed(address: string, allowList: string): boolean {
  const entries = allowList
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return true;
  const from = address.trim().toLowerCase();
  const domain = from.slice(from.lastIndexOf('@') + 1);
  return entries.some((e) => (e.indexOf('@') > 0 ? e === from : e.replace(/^@/, '') === domain));
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ what it needs

/** Everything the intake touches outside itself, so the rules can be tested without a database. */
export interface IntakeDeps {
  findEmail(internetMessageId: string): Promise<{ id: string; outcome: IntakeOutcome; contentHashes: string[] } | null>;
  saveEmail(message: MailMessage, outcome: IntakeOutcome, detail: string | null, existingId?: string): Promise<{ id: string }>;
  /** Creates the record and returns how many earlier records hold the same PDF. */
  createRecord(
    file: { buffer: Buffer; originalname: string; mimetype: string },
    notes: string,
    intakeEmailId: string,
  ): Promise<{ recordId: string; correlationId: string; duplicates: number }>;
  publish(recordId: string): Promise<void>;
  audit(recordId: string, message: string): Promise<void>;
  notifyReceived(emailId: string, title: string, body: string, recordId: string | null): Promise<void>;
}

export interface IntakeOptions {
  allowedSenders: string;
  maxBytes: number;
}

export interface MailResult {
  internetMessageId: string;
  from: string;
  subject: string;
  outcome: IntakeOutcome | 'ALREADY_DONE' | 'RETRY_LATER';
  records: string[];
  detail: string | null;
}

// ------------------------------------------------------------------ one pass

/**
 * Reads the intake folder once and handles every mail in it.
 *
 * A mail is moved out of the folder only after the database says what became of it, so a crash
 * between the two leaves it to be handled again; the stored Message-ID then recognises it, and
 * any PDF already turned into a record is not imported twice.
 */
export async function runMailIntakeOnce(source: MailSource, deps: IntakeDeps, opts: IntakeOptions): Promise<MailResult[]> {
  const messages = await source.listPending();
  const results: MailResult[] = [];
  for (const message of messages) {
    try {
      results.push(await handleMessage(source, deps, opts, message));
    } catch (err) {
      // One bad mail must not hold up the rest. It stays in the folder and is tried again next pass.
      log.error({ internetMessageId: message.internetMessageId, err: (err as Error).message }, 'could not import a mail; will retry');
      results.push(result(message, 'RETRY_LATER', [], (err as Error).message));
    }
  }
  return results;
}

function result(message: MailMessage, outcome: MailResult['outcome'], records: string[], detail: string | null): MailResult {
  return { internetMessageId: message.internetMessageId, from: message.fromAddress, subject: message.subject, outcome, records, detail };
}

async function handleMessage(source: MailSource, deps: IntakeDeps, opts: IntakeOptions, message: MailMessage): Promise<MailResult> {
  const existing = await deps.findEmail(message.internetMessageId);

  // Already decided on a previous pass; only the move did not happen.
  if (existing && existing.outcome !== 'IMPORTING') {
    await source.moveTo(message, existing.outcome === 'IMPORTED' ? 'done' : 'attention');
    return result(message, 'ALREADY_DONE', [], null);
  }

  const setAside = async (outcome: IntakeOutcome, detail: string) => {
    await deps.saveEmail(message, outcome, detail, existing?.id);
    await source.moveTo(message, 'attention');
    log.info({ from: message.fromAddress, subject: message.subject, outcome }, 'mail set aside');
    return result(message, outcome, [], detail);
  };

  if (!senderAllowed(message.fromAddress, opts.allowedSenders)) {
    return setAside('SENDER_NOT_ALLOWED', `${message.fromAddress || 'An unknown sender'} is not in MAIL_ALLOWED_SENDERS.`);
  }

  const attachments = await source.getAttachments(message, opts.maxBytes);
  const tooLarge = attachments.filter((a) => a.content === null && /\.pdf$/i.test(a.name)).map((a) => a.name);
  // A PDF, Excel workbook, CSV or attached Outlook email: anything the extractor reads. Pictures are
  // left out (in a mail they are logos and signatures), as is anything it cannot read.
  const pdfs = attachments
    .filter((a): a is typeof a & { content: Buffer } => a.content !== null)
    .flatMap((a) => {
      const d = detectDocument(a.content, a.name);
      return 'error' in d || d.kind === 'image' ? [] : [{ ...a, mimeType: d.mimeType }];
    });

  if (pdfs.length === 0) {
    const detail = tooLarge.length
      ? `PDF over the ${(opts.maxBytes / 1024 / 1024).toFixed(0)} MB limit: ${tooLarge.join(', ')}.`
      : attachments.length
        ? `No PDF or spreadsheet among the attachments (${attachments.map((a) => a.name).join(', ')}).`
        : 'The mail has no attachments.';
    return setAside('NO_PDF', detail);
  }

  const email = existing ?? (await deps.saveEmail(message, 'IMPORTING', null));
  const done = new Set(existing?.contentHashes ?? []);
  const notes = `Email from ${message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}: ${message.subject || '(no subject)'}`;

  const created: { recordId: string; correlationId: string; name: string }[] = [];
  const drafts: string[] = [];
  for (const pdf of pdfs.slice(0, MAX_PDFS_PER_MAIL)) {
    if (done.has(sha256(pdf.content))) continue; // imported on a pass that did not finish
    const rec = await deps.createRecord({ buffer: pdf.content, originalname: pdf.name, mimetype: pdf.mimeType }, notes, email.id);
    created.push({ ...rec, name: pdf.name });
    await deps.audit(rec.recordId, `${notes} (received ${message.receivedAt.toISOString()})`);

    // Like a drag-and-drop upload: a PDF seen before stays a draft for a person to decide on.
    if (rec.duplicates > 0) {
      drafts.push(rec.correlationId);
      continue;
    }
    try {
      await deps.publish(rec.recordId);
    } catch (err) {
      log.warn({ recordId: rec.recordId, err: (err as Error).message }, 'emailed PO left as a draft');
      drafts.push(rec.correlationId);
    }
  }

  const skipped = [
    ...(pdfs.length > MAX_PDFS_PER_MAIL
      ? [`${pdfs.length - MAX_PDFS_PER_MAIL} PDF(s) over the limit of ${MAX_PDFS_PER_MAIL} per mail were not imported`]
      : []),
    ...(tooLarge.length ? [`too large to import: ${tooLarge.join(', ')}`] : []),
  ];
  const detail =
    [
      `${created.length} record(s): ${created.map((c) => c.correlationId).join(', ') || 'none new'}`,
      drafts.length ? `left as draft (same PDF seen before): ${drafts.join(', ')}` : '',
      ...skipped,
    ]
      .filter(Boolean)
      .join('. ') + '.';

  await deps.saveEmail(message, 'IMPORTED', detail, email.id);
  const [only] = created;
  if (created.length > 0) {
    await deps.notifyReceived(
      email.id,
      created.length === 1 && only ? `PO received by email: ${only.name}` : `${created.length} POs received by email`,
      `${notes}.${drafts.length ? ` ${drafts.length} left as a draft because the same PDF was seen before.` : ''}`,
      created.length === 1 && only ? only.recordId : null,
    );
  }
  await source.moveTo(message, 'done');
  log.info({ from: message.fromAddress, subject: message.subject, records: created.length, drafts: drafts.length }, 'mail imported');
  return result(
    message,
    'IMPORTED',
    created.map((c) => c.correlationId),
    detail,
  );
}

// ------------------------------------------------------------------ the real wiring

let intakeActor: Actor | null = null;

/** The intake's own user, made on first use so a database seeded before this feature works too. */
export async function ensureIntakeUser(): Promise<Actor> {
  if (intakeActor) return intakeActor;
  const user = await prisma.user.upsert({
    where: { email: INTAKE_USER_EMAIL },
    update: {},
    create: {
      email: INTAKE_USER_EMAIL,
      name: INTAKE_USER_NAME,
      role: 'UPLOADER',
      // A password nobody knows: this user exists to be named as the uploader, never to sign in.
      passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10),
    },
  });
  intakeActor = { id: user.id, role: user.role, name: user.name };
  return intakeActor;
}

export function prismaDeps(actor: Actor): IntakeDeps {
  return {
    async findEmail(internetMessageId) {
      const row = await prisma.intakeEmail.findUnique({
        where: { internetMessageId },
        select: { id: true, outcome: true, records: { select: { sourceDocument: { select: { contentHash: true } } } } },
      });
      if (!row) return null;
      return {
        id: row.id,
        outcome: row.outcome,
        contentHashes: row.records.flatMap((r) => (r.sourceDocument ? [r.sourceDocument.contentHash] : [])),
      };
    },
    async saveEmail(m, outcome, detail, existingId) {
      if (existingId) return prisma.intakeEmail.update({ where: { id: existingId }, data: { outcome, detail }, select: { id: true } });
      return prisma.intakeEmail.create({
        data: {
          internetMessageId: m.internetMessageId,
          graphMessageId: m.id,
          fromAddress: m.fromAddress,
          fromName: m.fromName,
          subject: m.subject,
          receivedAt: m.receivedAt,
          outcome,
          detail,
        },
        select: { id: true },
      });
    },
    async createRecord(file, notes, intakeEmailId) {
      const { record, duplicates } = await createRecord(actor, file, { notes, intakeEmailId });
      return { recordId: record.id, correlationId: record.correlationId, duplicates: duplicates.length };
    },
    async publish(recordId) {
      await publishRecord(actor, recordId);
    },
    async audit(recordId, message) {
      await writeAudit({ recordId, eventType: 'RECORD_RECEIVED_BY_EMAIL', message, actorId: actor.id });
    },
    async notifyReceived(emailId, title, body, recordId) {
      await notify({ kind: 'EMAIL_PO_RECEIVED', dedupeKey: `email:${emailId}`, recordId, title, body });
    },
  };
}

export function mailIntakeConfigured(): string[] {
  const missing = (
    [
      ['MS_TENANT_ID', env.MS_TENANT_ID],
      ['MS_CLIENT_ID', env.MS_CLIENT_ID],
      ['MS_CLIENT_SECRET', env.MS_CLIENT_SECRET],
      ['MAIL_MAILBOX', env.MAIL_MAILBOX],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return missing;
}

// ------------------------------------------------------------------ status, and one pass at a time

export interface IntakeStatus {
  enabled: boolean;
  /** delegated: read as the person who clicked "Connect Outlook"; app: the app's own permission. */
  authMode: 'delegated' | 'app';
  /** Who "Connect Outlook" signed in as (delegated only); null until someone has. */
  connection: { account: string; connectedAt: string } | null;
  mailbox: string;
  folder: string;
  allowedSenders: string[];
  pollSeconds: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResults: MailResult[];
}

const state: Omit<IntakeStatus, 'enabled' | 'authMode' | 'mailbox' | 'folder' | 'allowedSenders' | 'pollSeconds'> = {
  connection: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastResults: [],
};

let source: MailSource | null = null;
let inFlight: Promise<MailResult[]> | null = null;

/** An outage is announced again at most this often, so a long one is not a flood. */
const REANNOUNCE_MS = 6 * 3600_000;

/**
 * One pass, shared: the worker and the "check mail now" button never read the folder at the
 * same time, which would import a mail twice.
 */
export function runMailIntake(): Promise<MailResult[]> {
  if (!inFlight) inFlight = onePass().finally(() => (inFlight = null));
  return inFlight;
}

/** Re-reads who "Connect Outlook" signed in as, for the status shown in the app. */
export async function refreshMailConnection(): Promise<void> {
  if (env.MAIL_AUTH_MODE !== 'delegated') return;
  const c = await mailConnection();
  state.connection = c ? { account: c.account, connectedAt: c.connectedAt.toISOString() } : null;
}

/** After "Connect Outlook" or a disconnect: forget the cached folders and errors, and look again. */
export async function mailConnectionChanged(): Promise<void> {
  source = null;
  state.lastError = null;
  await refreshMailConnection();
}

async function onePass(): Promise<MailResult[]> {
  state.lastRunAt = new Date().toISOString();
  if (env.MAIL_AUTH_MODE === 'delegated') {
    await refreshMailConnection().catch(() => undefined);
    // Not an outage: nobody has connected yet. Say so on the status, without raising alerts every minute.
    if (!state.connection) {
      state.lastError = NOT_CONNECTED;
      return [];
    }
  }
  try {
    source ??= new GraphMailSource({
      tokens: env.MAIL_AUTH_MODE === 'delegated' ? storedTokens : undefined,
      tenantId: env.MS_TENANT_ID,
      clientId: env.MS_CLIENT_ID,
      clientSecret: env.MS_CLIENT_SECRET,
      mailbox: env.MAIL_MAILBOX,
      sourceFolder: env.MAIL_SOURCE_FOLDER,
      doneFolder: env.MAIL_DONE_FOLDER,
      attentionFolder: env.MAIL_ATTENTION_FOLDER,
    });
    const actor = await ensureIntakeUser();
    const results = await runMailIntakeOnce(source, prismaDeps(actor), {
      allowedSenders: env.MAIL_ALLOWED_SENDERS,
      maxBytes: env.MAX_UPLOAD_BYTES,
    });
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    if (results.length > 0) state.lastResults = results.slice(-20);
    return results;
  } catch (err) {
    const message = (err as Error).message;
    state.lastError = message;
    // A missing folder may be created in a minute; look the folders up again next time.
    source = null;
    log.error({ err: message }, 'mail intake pass failed');
    await notifyIntegration(`mail-intake:${Math.floor(Date.now() / REANNOUNCE_MS)}`, 'The Outlook mailbox cannot be read', message);
    throw err;
  }
}

export function mailIntakeStatus(): IntakeStatus {
  return {
    enabled: env.MAIL_INTAKE_ENABLED,
    authMode: env.MAIL_AUTH_MODE,
    mailbox: env.MAIL_MAILBOX,
    folder: env.MAIL_SOURCE_FOLDER,
    allowedSenders: env.MAIL_ALLOWED_SENDERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pollSeconds: Math.round(env.MAIL_POLL_MS / 1000),
    ...state,
  };
}
