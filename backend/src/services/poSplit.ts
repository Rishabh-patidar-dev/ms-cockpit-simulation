import { detectDocumentKind, isSpreadsheet, MIME_TYPES } from './documentKind.js';
import { readSpreadsheet } from './spreadsheet.js';

/**
 * A spreadsheet that is several POs in one: a PO-number column whose rows name two or more
 * different POs (an SAP export, one row per item, is the usual case). Read as one record it
 * has no single PO number to give, so it is split before it becomes records: one CSV per PO,
 * each with the heading row and that PO's rows, exactly as they were.
 *
 * Deliberately narrow, so a delivery schedule is not shredded: one sheet with data, a column
 * headed like a PO number, a value in that column on every data row, and at most
 * MAX_SPLIT_POS different POs. Anything else stays one record, read as before.
 */
export const MAX_SPLIT_POS = 10;

const PO_HEADING = /^(po|purchase\s*order|p\.o\.|purch\.?\s*doc\.?|customer\s*po)[\s_.\-#]*(number|no\.?|num|nr|#)?$/i;

export interface SplitPart {
  poNumber: string;
  name: string;
  content: Buffer;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** A row as CSV, without the empty cells the grid pads it with on the right. */
const csvRow = (r: string[]) => {
  let end = r.length;
  while (end > 0 && r[end - 1] === '') end--;
  return r.slice(0, end).map(csvCell).join(',');
};

/** The parts, or null when the file is one PO (or not clearly several). */
export async function splitByPoNumber(buffer: Buffer, kind: 'xlsx' | 'csv', filename: string): Promise<SplitPart[] | null> {
  let wb;
  try {
    wb = await readSpreadsheet(buffer, kind, filename);
  } catch {
    return null; // unreadable here is reported, properly, when the record is extracted
  }
  const sheets = wb.sheets.filter((s) => !s.hidden && s.rows.some((r) => r.some((v) => v !== '')));
  if (sheets.length !== 1) return null;
  const rows = sheets[0]!.rows;

  // The heading row is near the top: the first of the first ten rows with a PO-number heading.
  let headRow = -1;
  let col = -1;
  for (let r = 0; r < Math.min(10, rows.length) && headRow < 0; r++) {
    const c = rows[r]!.findIndex((v) => PO_HEADING.test(v.trim()));
    if (c >= 0) [headRow, col] = [r, c];
  }
  if (headRow < 0) return null;

  const data = rows.slice(headRow + 1).filter((r) => r.some((v) => v !== ''));
  if (data.length < 2 || data.some((r) => !(r[col] ?? '').trim())) return null;
  const order: string[] = [];
  const byPo = new Map<string, string[][]>();
  for (const r of data) {
    const po = r[col]!.trim();
    if (!byPo.has(po)) {
      byPo.set(po, []);
      order.push(po);
    }
    byPo.get(po)!.push(r);
  }
  if (order.length < 2 || order.length > MAX_SPLIT_POS) return null;

  const base = filename.replace(/\.(csv|xlsx|xlsm)$/i, '');
  const heading = rows.slice(0, headRow + 1);
  return order.map((po) => ({
    poNumber: po,
    name: `${base} - PO ${po.replace(/[^\w.-]+/g, '_')}.csv`,
    content: Buffer.from([...heading, ...byPo.get(po)!].map(csvRow).join('\r\n') + '\r\n', 'utf8'),
  }));
}

export interface PoFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  /** Set on a part of a split file: which file it came from, and which PO it is. */
  splitFrom?: { file: string; poNumber: string; of: number };
}

/** The files to make records from: the file itself, or one CSV per PO when it holds several. */
export async function expandPoFile(file: PoFile): Promise<PoFile[]> {
  const kind = detectDocumentKind(file.buffer, file.originalname);
  if (!isSpreadsheet(kind)) return [file];
  const parts = await splitByPoNumber(file.buffer, kind, file.originalname);
  if (!parts) return [file];
  return parts.map((p) => ({
    buffer: p.content,
    originalname: p.name,
    mimetype: MIME_TYPES.csv,
    splitFrom: { file: file.originalname, poNumber: p.poNumber, of: parts.length },
  }));
}

/** The note a record made from part of a split file carries. */
export const splitNote = (s: NonNullable<PoFile['splitFrom']>) =>
  `PO ${s.poNumber}, one of ${s.of} POs in ${s.file} (the file was split into one record per PO number)`;
