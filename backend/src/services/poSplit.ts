import { detectDocumentKind, isSpreadsheet, MIME_TYPES } from './documentKind.js';
import { readSpreadsheet } from './spreadsheet.js';

/**
 * A spreadsheet that is several POs in one. Read as one record it has no single PO number to
 * give, so it is split before it becomes records: one CSV per PO, each with the heading rows and
 * that PO's rows, exactly as they were. Two shapes are recognised; anything else stays one
 * record, read as before.
 *
 * 1. A list of order lines (an SAP export, one row per item): a column headed like a PO number,
 *    a value in it on every row, and 2 to MAX_SPLIT_POS different POs.
 *
 * 2. A delivery schedule (Varroc's monthly schedule): a PO-number column, and quantities by
 *    month ("Oct'26 Firm Plan", "Nov'26", ... or "Oct 26", "Nov 26", ...). The month ordered is
 *    the one marked firm, or else the first month column; the later ones are a forecast. Only
 *    the rows with a quantity in that month are orders, so each PO with at least one such row
 *    becomes a record holding just those rows, and a PO with nothing ordered this month makes
 *    no record. Up to MAX_SCHEDULE_POS POs.
 */
export const MAX_SPLIT_POS = 10;
/** As many as one email may bring (the Outlook intake's limit). */
export const MAX_SCHEDULE_POS = 50;

const PO_HEADING = /^(po|purchase\s*order|p\.o\.|purch\.?\s*doc\.?|customer\s*po)[\s_.\-#]*(number|no\.?|num|nr|#)?$/i;
/** A month column: "Oct'26 Firm Plan", "Nov'26", "Oct 26", "July'27", "Oct-2026". A forecast ("Apr FC.27") is not one. */
const MONTH_HEADING = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s'’`\-]*\d{2}(\d{2})?\b/i;

export interface SplitPart {
  poNumber: string;
  name: string;
  content: Buffer;
  /** For a schedule: the month column the quantities are in, and how many rows were ordered. */
  quantityColumn?: string;
  lines: number;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** A row as CSV, without the empty cells the grid pads it with on the right. */
const csvRow = (r: string[]) => {
  let end = r.length;
  while (end > 0 && r[end - 1] === '') end--;
  return r.slice(0, end).map(csvCell).join(',');
};

/**
 * The PO number in a cell, or '' when there is none yet. A PO number has a digit in it; words in
 * the PO column ("PO in process", "TBD", "NA", "-") say the PO has not been issued.
 */
export const poNumberIn = (v: string | undefined) => {
  const t = (v ?? '').trim();
  return /\d/.test(t) ? t : '';
};

/** A quantity above zero: "41400", "1,358,681", "2.5". Blank, 0, text: no. */
const ordered = (v: string | undefined) => {
  const n = Number((v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0;
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
  const headings = rows[headRow]!.map((v) => v.trim());
  const data = rows.slice(headRow + 1).filter((r) => r.some((v) => v !== ''));

  // A schedule: the month ordered is the one marked firm, or else the first month column.
  const months = headings.map((h, i) => (MONTH_HEADING.test(h) ? i : -1)).filter((i) => i >= 0);
  const qtyCol = months.length >= 2 ? (months.find((i) => /firm/i.test(headings[i]!)) ?? months[0]!) : -1;
  const rowsToSplit = qtyCol >= 0 ? data.filter((r) => ordered(r[qtyCol])) : data;
  const limit = qtyCol >= 0 ? MAX_SCHEDULE_POS : MAX_SPLIT_POS;

  // In a list every line names its PO. In a schedule a new item may be ordered before its PO
  // exists: those rows are kept together as one record with no PO number, for the reviewer.
  if (rowsToSplit.length === 0) return null;
  if (qtyCol < 0 && rowsToSplit.some((r) => !poNumberIn(r[col]))) return null;
  const order: string[] = [];
  const byPo = new Map<string, string[][]>();
  for (const r of rowsToSplit) {
    const po = poNumberIn(r[col]);
    if (!byPo.has(po)) {
      byPo.set(po, []);
      order.push(po);
    }
    byPo.get(po)!.push(r);
  }
  // A list of lines for one PO is one PO. A schedule is split even for one PO, because its other
  // rows (other POs, nothing ordered) are not part of that order.
  const allRowsOnePo = qtyCol < 0 && order.length < 2;
  if (allRowsOnePo || order.length > limit) return null;
  if (qtyCol >= 0 && order.length === 1 && rowsToSplit.length === data.length) return null;

  const base = filename.replace(/\.(csv|xlsx|xlsm)$/i, '');
  const heading = rows.slice(0, headRow + 1);
  return order.map((po) => ({
    poNumber: po,
    name: po ? `${base} - PO ${po.replace(/[^\w.-]+/g, '_')}.csv` : `${base} - no PO number.csv`,
    content: Buffer.from([...heading, ...byPo.get(po)!].map(csvRow).join('\r\n') + '\r\n', 'utf8'),
    ...(qtyCol >= 0 ? { quantityColumn: headings[qtyCol]! } : {}),
    lines: byPo.get(po)!.length,
  }));
}

export interface PoFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  /** Set on a part of a split file: which file it came from, and which PO it is. */
  splitFrom?: { file: string; poNumber: string; of: number; quantityColumn?: string; lines?: number };
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
    splitFrom: { file: file.originalname, poNumber: p.poNumber, of: parts.length, quantityColumn: p.quantityColumn, lines: p.lines },
  }));
}

/** The note a record made from part of a split file carries. */
export const splitNote = (s: NonNullable<PoFile['splitFrom']>) =>
  s.quantityColumn && !s.poNumber
    ? `${s.lines} line(s) ordered under "${s.quantityColumn}" in the schedule ${s.file} with no PO number on them. Ask the customer for the PO number, or enter it, before approving`
    : s.quantityColumn
    ? `PO ${s.poNumber}: ${s.lines} line(s) ordered under "${s.quantityColumn}", one of ${s.of} PO(s) with a quantity in that month in the schedule ${s.file}. The schedule's other rows (other POs, later months, nothing ordered) are not part of this record`
    : `PO ${s.poNumber}, one of ${s.of} POs in ${s.file} (the file was split into one record per PO number)`;
