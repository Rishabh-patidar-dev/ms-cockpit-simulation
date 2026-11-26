import ExcelJS from 'exceljs';

/**
 * Spreadsheet POs (.xlsx and .csv): read the cells as they are, so nothing is lost to OCR.
 *
 * What comes out is a grid of display strings per sheet, used twice: as text for the
 * extractor (every value carries its cell reference, e.g. P8, so a reviewer can find it)
 * and as the preview the review screen shows in place of a PDF.
 *
 * Formulas are read as the value Excel last calculated, never as the formula. Macros in
 * an .xlsm are never run: only the cell values are read.
 */

export interface SheetGrid {
  name: string;
  /** Hidden sheets are kept out of extraction but listed, so a reviewer knows they exist. */
  hidden: boolean;
  /** rows[r][c] is the cell at row r+1, column c+1. Empty cells are "". */
  rows: string[][];
  /** 1-based row and column numbers that Excel hides. */
  hiddenRows: number[];
  hiddenColumns: number[];
  /** Merged ranges, e.g. "A1:T1". The value is in the top-left cell only. */
  merges: string[];
  /** True when the sheet was larger than the limits and only its top-left part was read. */
  truncated: boolean;
}

export interface Workbook {
  sheets: SheetGrid[];
}

/** Beyond this a sheet is not a PO; what is read is still shown, and the cut is said out loud. */
export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 100;
/** A cell longer than this is cut in the extractor's text (the preview keeps it whole). */
const MAX_CELL_TEXT = 300;

// ------------------------------------------------------------------ cell references

/** 1 → A, 27 → AA. */
export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export const cellRef = (row: number, column: number) => `${columnLetter(column)}${row}`;

// ------------------------------------------------------------------ .xlsx

const isoDate = (d: Date) => {
  // Excel dates have no time zone; exceljs hands them over as UTC midnight.
  const day = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  return time === '00:00:00' ? day : `${day} ${time}`;
};

/** A number as Excel would show it without formatting: no float noise such as 0.30720000000000003. */
const plainNumber = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15))));

function display(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'number') return plainNumber(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if ('formula' in value || 'sharedFormula' in value) return display((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('error' in value) return String(value.error);
    if ('text' in value && typeof (value as { text: unknown }).text === 'string') return (value as { text: string }).text;
    if ('hyperlink' in value) return String((value as { hyperlink: string }).hyperlink);
  }
  return String(value);
}

export async function readXlsx(buffer: Buffer): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs types its argument as an ArrayBuffer-ish Buffer of its own; a Node Buffer is what it reads.
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new SpreadsheetError(`The workbook could not be opened: ${(err as Error).message}`);
  }

  const sheets: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const rowCount = Math.min(ws.rowCount, MAX_ROWS);
    const columnCount = Math.min(ws.columnCount, MAX_COLUMNS);
    const rows: string[][] = [];
    const hiddenRows: number[] = [];
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      if (row.hidden) hiddenRows.push(r);
      const cells: string[] = [];
      for (let c = 1; c <= columnCount; c++) {
        const cell = row.getCell(c);
        // A merged range repeats its value in every cell; keep it in the top-left one only.
        cells.push(cell.isMerged && cell.master.address !== cell.address ? '' : display(cell.value).trim());
      }
      rows.push(cells);
    }
    const hiddenColumns: number[] = [];
    for (let c = 1; c <= columnCount; c++) if (ws.getColumn(c).hidden) hiddenColumns.push(c);

    sheets.push({
      name: ws.name,
      hidden: ws.state !== 'visible',
      rows: trimGrid(rows),
      hiddenRows,
      hiddenColumns,
      merges: [...((ws.model as { merges?: string[] }).merges ?? [])],
      truncated: ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLUMNS,
    });
  });
  if (sheets.length === 0) throw new SpreadsheetError('The workbook has no sheets.');
  return { sheets };
}

// ------------------------------------------------------------------ .csv

/** Excel on Windows saves CSV as Windows-1252 unless told otherwise; UTF-8 is tried first. */
export function decodeText(buffer: Buffer): string {
  const text = (() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return new TextDecoder('windows-1252').decode(buffer);
    }
  })();
  return text.replace(/^﻿/, '');
}

/** The delimiter that splits the first lines most evenly: comma, semicolon (European Excel) or tab. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t']) {
    const counts = sample.map((l) => parseCsvLine(l, d).length);
    const min = Math.min(...counts);
    // Most columns, and the same count on every line, wins.
    const score = min > 1 ? min * (counts.every((n) => n === counts[0]) ? 2 : 1) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  return parseCsv(line, delimiter)[0] ?? [];
}

/** RFC 4180: quoted fields may hold the delimiter, doubled quotes and line breaks. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsv(buffer: Buffer, name = 'CSV'): Workbook {
  const text = decodeText(buffer);
  const parsed = parseCsv(text, text.trim() ? detectDelimiter(text) : ',');
  const truncated = parsed.length > MAX_ROWS || parsed.some((r) => r.length > MAX_COLUMNS);
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...parsed.map((r) => r.length)));
  const rows = parsed.slice(0, MAX_ROWS).map((r) => Array.from({ length: width }, (_, c) => (r[c] ?? '').trim()));
  return { sheets: [{ name, hidden: false, rows: trimGrid(rows), hiddenRows: [], hiddenColumns: [], merges: [], truncated }] };
}

// ------------------------------------------------------------------ shared

export class SpreadsheetError extends Error {}

/** Drops empty rows and columns at the end, so a sheet formatted to row 1,048,576 is not a huge grid. */
function trimGrid(rows: string[][]): string[][] {
  let lastRow = rows.length;
  while (lastRow > 0 && rows[lastRow - 1]!.every((v) => v === '')) lastRow--;
  const kept = rows.slice(0, lastRow);
  let lastCol = 0;
  for (const r of kept) for (let c = r.length; c > lastCol; c--) if (r[c - 1] !== '') { lastCol = c; break; }
  return kept.map((r) => r.slice(0, lastCol));
}

export async function readSpreadsheet(buffer: Buffer, kind: 'xlsx' | 'csv', filename?: string): Promise<Workbook> {
  return kind === 'xlsx' ? readXlsx(buffer) : readCsv(buffer, filename?.replace(/\.csv$/i, '') || 'CSV');
}

/**
 * The workbook as text for the extractor: one line per non-empty row, each value with its
 * cell reference. Cells Excel hides are kept but marked "(hidden)": customers hide old POs
 * and past months, and the same hiding often takes a row's label or the sheet's title with
 * it, which the extractor still needs to read the visible values. Hidden sheets are left
 * out and named.
 */
export function workbookToText(wb: Workbook): string {
  const visible = wb.sheets.filter((s) => !s.hidden);
  const parts: string[] = [];
  visible.forEach((sheet, i) => {
    const hiddenRows = new Set(sheet.hiddenRows);
    const hiddenCols = new Set(sheet.hiddenColumns);
    const width = Math.max(0, ...sheet.rows.map((r) => r.length));
    parts.push(`### Sheet ${i + 1} of ${visible.length}: "${sheet.name}" (${sheet.rows.length} rows x ${width} columns)`);
    if (sheet.merges.length) parts.push(`Merged cells (value in the first cell): ${sheet.merges.join(', ')}`);
    if (hiddenCols.size) parts.push(`Hidden columns: ${[...hiddenCols].map(columnLetter).join(', ')}`);
    if (hiddenRows.size) parts.push(`Hidden rows: ${[...hiddenRows].join(', ')}`);
    sheet.rows.forEach((row, r) => {
      const cells = row
        .map((v, c) => ({ v, c: c + 1 }))
        .filter(({ v }) => v !== '')
        .map(({ v, c }) => `${cellRef(r + 1, c)}${hiddenRows.has(r + 1) || hiddenCols.has(c) ? '(hidden)' : ''}=${oneLine(v)}`);
      if (cells.length) parts.push(`Row ${r + 1}: ${cells.join(' | ')}`);
    });
    if (sheet.truncated) parts.push(`(The sheet is larger than ${MAX_ROWS} rows or ${MAX_COLUMNS} columns; only that part was read.)`);
    parts.push('');
  });
  const hidden = wb.sheets.filter((s) => s.hidden).map((s) => `"${s.name}"`);
  if (hidden.length) parts.push(`Hidden sheets not included: ${hidden.join(', ')}.`);
  return parts.join('\n').trim();
}

const oneLine = (v: string) => {
  const flat = v.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '/');
  return flat.length > MAX_CELL_TEXT ? `${flat.slice(0, MAX_CELL_TEXT)}…` : flat;
};
