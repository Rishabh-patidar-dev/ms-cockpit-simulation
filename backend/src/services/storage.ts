import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { sha256 } from '../lib/ids.js';
import { STORED_NAMES, type DocumentKind } from './documentKind.js';

export { looksLikePdf } from './documentKind.js';

/**
 * FR-1.1 / FR-1.9 — the original PDF is stored unmodified and stays viewable at every
 * later stage. Files are addressed by record id so that a leaked storage path for one
 * record reveals nothing about another (NFR-3.5 is enforced at the API layer).
 */
export async function ensureDirectories(): Promise<void> {
  await Promise.all(
    [
      env.paths.documents,
      env.paths.outbound,
      env.paths.staging,
      env.paths.inbound,
      env.paths.archive,
      env.paths.quarantine,
    ].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

export interface StoredDocument {
  storagePath: string;
  contentHash: string;
  byteSize: number;
  pageCount: number | null;
}

export async function storeDocument(recordId: string, buffer: Buffer, kind: DocumentKind = 'pdf'): Promise<StoredDocument> {
  const dir = path.join(env.paths.documents, recordId);
  await fs.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, STORED_NAMES[kind]);
  await fs.writeFile(storagePath, buffer);
  return {
    storagePath,
    contentHash: sha256(buffer),
    byteSize: buffer.byteLength,
    pageCount: kind === 'pdf' ? countPdfPages(buffer) : null,
  };
}

/**
 * Read a record's PDF. The disk copy is only a warm cache — free-tier hosts wipe it
 * on every deploy and wake-from-sleep — so on a miss the bytes come back from the
 * database (SourceDocument.content) and the cache is re-warmed. Returns null when
 * neither copy exists, which can only happen for records uploaded before the content
 * column existed whose disk copy is gone; that loss is permanent, and the caller
 * turns it into a clear error rather than an ENOENT.
 */
export async function loadDocumentContent(
  recordId: string,
  storagePath: string,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(storagePath);
  } catch {
    /* cache miss — fall through to the database copy */
  }

  const doc = await prisma.sourceDocument.findUnique({
    where: { recordId },
    select: { content: true },
  });
  if (!doc?.content) return null;

  const buffer = Buffer.from(doc.content);
  // Re-warm the disk cache; a failure here costs nothing but the next read's speed.
  fs.mkdir(path.dirname(storagePath), { recursive: true })
    .then(() => fs.writeFile(storagePath, buffer))
    .catch(() => {});
  return buffer;
}

export async function deleteDocument(recordId: string): Promise<void> {
  await fs.rm(path.join(env.paths.documents, recordId), { recursive: true, force: true });
}

/**
 * Page count without pulling in a PDF library. The page tree's root says how many pages
 * there are (/Count, the largest one in the file); counting /Type /Page objects is the
 * fallback, and overcounts when a file carries old revisions. Null rather than a guess.
 * Shown on screen, and used to decide when a long PDF is read a few pages at a time.
 */
export function countPdfPages(buffer: Buffer): number | null {
  const text = buffer.toString('latin1');
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(...counts);
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}
