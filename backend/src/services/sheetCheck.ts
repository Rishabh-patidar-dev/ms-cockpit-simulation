import type { HeaderWithLines, ValidationIssue } from '../domain/validation.js';
import { validateRecord } from '../domain/validation.js';
import { buildCellIndex, sheetValueIssues, type CellIndex } from '../domain/sheetCheck.js';
import { prisma } from '../db/client.js';
import { childLogger } from '../lib/logger.js';
import { isSpreadsheet, kindOfMimeType } from './documentKind.js';
import { readSpreadsheet } from './spreadsheet.js';
import { loadDocumentContent } from './storage.js';

const log = childLogger('sheet-check');

/** Cells of recently checked sheets, by content hash: the review screen re-validates every few seconds. */
const cache = new Map<string, CellIndex>();
const CACHE_SIZE = 50;

async function cellsOf(recordId: string, doc: SheetDoc): Promise<CellIndex | null> {
  const hit = cache.get(doc.contentHash);
  if (hit) return hit;
  const buffer = await loadDocumentContent(recordId, doc.storagePath);
  if (!buffer) return null;
  const kind = kindOfMimeType(doc.mimeType);
  if (!isSpreadsheet(kind)) return null;
  const wb = await readSpreadsheet(buffer, kind, doc.originalFilename);
  // Hidden sheets are left in: the model is told about hidden cells, and a value it took from one is still on the sheet.
  const index = buildCellIndex(wb.sheets.flatMap((s) => s.rows.flat()));
  cache.set(doc.contentHash, index);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return index;
}

interface SheetDoc {
  contentHash: string;
  storagePath: string;
  mimeType: string;
  originalFilename: string;
}

/**
 * The spreadsheet check (domain/sheetCheck.ts) for one record: warnings for values read from a
 * spreadsheet that appear in none of its cells. Empty for a PDF. A sheet that cannot be read
 * here adds nothing rather than blocking review: extraction already read it once.
 */
export async function spreadsheetIssues(record: {
  id: string;
  header: HeaderWithLines | null;
  sourceDocument: SheetDoc | null;
}): Promise<ValidationIssue[]> {
  const doc = record.sourceDocument;
  if (!record.header || !doc || !isSpreadsheet(kindOfMimeType(doc.mimeType))) return [];
  try {
    const index = await cellsOf(record.id, doc);
    if (!index) return [];
    const edited = await prisma.fieldExtraction.findMany({
      where: { recordId: record.id, editedAt: { not: null } },
      select: { fieldPath: true },
    });
    return sheetValueIssues(record.header, index, new Set(edited.map((e) => e.fieldPath)));
  } catch (err) {
    log.warn({ recordId: record.id, err: (err as Error).message }, 'spreadsheet check skipped');
    return [];
  }
}

/** Everything validation says about a record: the usual rules, plus the spreadsheet check. */
export async function validateRecordWithSheet(record: Parameters<typeof spreadsheetIssues>[0]): Promise<ValidationIssue[]> {
  return [...(await validateRecord(record.header)), ...(await spreadsheetIssues(record))];
}
