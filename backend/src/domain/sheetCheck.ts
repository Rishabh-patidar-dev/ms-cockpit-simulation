import type { HeaderWithLines, ValidationIssue } from './validation.js';
import { headerFieldPath, lineFieldPath, type HeaderField, type LineField } from './types.js';
import { normaliseDecimal } from './validation.js';

/**
 * A spreadsheet PO holds its values as typed cells, so every value read from it can be
 * checked against the sheet itself. The model still misreads now and then (PRT2040011 came
 * back as PRT2040010 from a cell that says PRT2040011), and such a slip looks perfectly
 * plausible to a reviewer. A value that appears in no cell is flagged, and the record cannot
 * be approved until someone corrects it or accepts it.
 *
 * Only the values SAP acts on are checked. Dates are left out (the model may write a date in
 * the PO's own words while the cell holds a date value), and so is anything a person typed
 * in review: a customer code that is not on the sheet is the reviewer's to add.
 */

export const NOT_IN_SHEET = 'NOT_IN_SPREADSHEET';

export const CHECKED_HEADER_FIELDS: readonly HeaderField[] = ['poNumber', 'customerCode', 'currency', 'poTotalValue'];
export const CHECKED_LINE_FIELDS: readonly LineField[] = [
  'materialCode',
  'customerMaterialNumber',
  'quantity',
  'uom',
  'unitPrice',
  'lineNetValue',
];

/** What the sheet holds, prepared for lookups. */
export interface CellIndex {
  /** Every non-empty cell, lower-cased with runs of spaces collapsed. */
  texts: string[];
  /** Every cell that reads as a number, as a number. */
  numbers: number[];
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The numbers a string could mean, written in any of the usual ways (1,234.50 / 1.234,50 /
 * 27000.00). "27,000" could be twenty-seven thousand or twenty-seven, so both are returned.
 */
function asNumbers(raw: string): number[] {
  if (!/\d/.test(raw) || /[a-z]/i.test(raw)) return [];
  const out: number[] = [];
  const n = normaliseDecimal(raw);
  if (n !== null && Number.isFinite(Number(n))) out.push(Number(n));
  if (/^-?\d{1,3}[.,]\d{3}$/.test(raw.trim())) out.push(Number(raw.trim().replace(/[.,]/, '')));
  return out;
}

export function buildCellIndex(cells: Iterable<string>): CellIndex {
  const texts: string[] = [];
  const numbers: number[] = [];
  for (const cell of cells) {
    if (!cell.trim()) continue;
    texts.push(squash(cell));
    numbers.push(...asNumbers(cell.trim()));
  }
  return { texts, numbers };
}

/** The same number, allowing for float noise in a calculated cell (0.30720000000000003). */
const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Is this value on the sheet? A number matches a cell holding the same number, however it is
 * written. Text matches a whole cell, or a part of one, since a PO number is often inside a
 * longer heading ("PO 2026-118 (06.10.2026)"). A code is never matched inside a longer code:
 * PRT2040010 is not "in" a cell that says PRT2040010X.
 */
export function valueInSheet(value: string, index: CellIndex): boolean {
  const v = squash(value);
  if (!v) return true;
  if (asNumbers(value.trim()).some((n) => index.numbers.some((c) => sameNumber(c, n)))) return true;
  if (index.texts.includes(v)) return true;
  // A part of a cell, but only on word edges, so one code cannot hide inside another.
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const edged = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`);
  return index.texts.some((t) => t.length > v.length && edged.test(t));
}

/** Warnings for the values the model read that are on no cell of the sheet. */
export function sheetValueIssues(
  header: HeaderWithLines | null,
  index: CellIndex,
  editedFieldPaths: ReadonlySet<string>,
): ValidationIssue[] {
  if (!header) return [];
  const issues: ValidationIssue[] = [];
  const check = (fieldPath: string, label: string, value: string | null | undefined) => {
    if (value == null || !value.trim() || editedFieldPaths.has(fieldPath)) return;
    if (valueInSheet(value, index)) return;
    issues.push({
      code: NOT_IN_SHEET,
      severity: 'WARNING',
      fieldPath,
      message: `${label} "${value}" does not appear anywhere in the spreadsheet. Check it against the sheet: correct it, or accept it if it is right.`,
    });
  };
  for (const f of CHECKED_HEADER_FIELDS) check(headerFieldPath(f), HEADER_NAMES[f] ?? f, header[f] as string | null);
  for (const line of header.lineItems) {
    for (const f of CHECKED_LINE_FIELDS) {
      check(lineFieldPath(line.lineNumber, f), `Line ${line.lineNumber}: ${LINE_NAMES[f] ?? f}`, line[f] as string | null);
    }
  }
  return issues;
}

const HEADER_NAMES: Record<string, string> = {
  poNumber: 'PO number',
  customerCode: 'Customer code',
  currency: 'Currency',
  poTotalValue: 'PO total',
};
const LINE_NAMES: Record<string, string> = {
  materialCode: 'material',
  customerMaterialNumber: 'customer material',
  quantity: 'quantity',
  uom: 'unit',
  unitPrice: 'unit price',
  lineNetValue: 'line value',
};
