import { HEADER_FIELDS, type ExtractionResult } from '../../domain/types.js';
import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from './types.js';

/**
 * A long PDF read in page ranges. Asked for every line of a 36-page, 411-line PO at once,
 * the model returned 30 lines and stopped: the answer is too long to give in one go. So a
 * PDF past EXTRACTION_PAGES_PER_CALL pages is sent once per range of pages, each request
 * asking for the lines printed on those pages only, and the answers are put back together
 * in page order. The whole file goes with every request, so a range can still read the
 * table headings and the header block on page 1.
 */

/** The most requests one document is split into; past that the ranges get wider instead. */
export const MAX_PAGE_CALLS = 10;

export function pageRanges(pageCount: number, perCall: number): [number, number][] {
  if (perCall <= 0 || pageCount <= perCall) return [];
  const size = Math.max(perCall, Math.ceil(pageCount / MAX_PAGE_CALLS));
  const ranges: [number, number][] = [];
  for (let from = 1; from <= pageCount; from += size) ranges.push([from, Math.min(pageCount, from + size - 1)]);
  return ranges;
}

export const rangeNote = (from: number, to: number, pageCount: number) => `---
This PO is ${pageCount} pages long, so its line items are read a few pages at a time. In THIS request:
- Extract the header fields as usual, from wherever they are printed in the document.
- Return ONLY the line items printed on pages ${from} to ${to} (counting the PDF's pages from 1). Return every one of them, in order, and none from other pages.
- A line item that starts on page ${to} and continues onto the next page belongs to this request; one that started before page ${from} does not.
- Keep the line numbers the document prints (its S.No. or line number), so the parts can be put back together.`;

const key = (l: ExtractionResult['lineItems'][number]) =>
  [l.lineNumber, l.materialCode?.value, l.customerMaterialNumber?.value, l.description?.value, l.quantity?.value, l.unitPrice?.value, l.plant?.value].join('|');

/** The ranges' answers as one: the first header value found for each field, and the lines in order, without a line read twice at a boundary. */
export function mergeRanges(parts: ExtractionResult[]): ExtractionResult {
  const header = Object.fromEntries(
    HEADER_FIELDS.map((f) => {
      const found = parts.map((p) => p.header[f]).find((c) => c?.value != null && c.value !== '');
      return [f, found ?? parts[0]!.header[f]];
    }),
  ) as ExtractionResult['header'];

  const lineItems: ExtractionResult['lineItems'] = [];
  let lastOfPrevious: string | null = null;
  for (const part of parts) {
    const sorted = [...part.lineItems].sort((a, b) => a.lineNumber - b.lineNumber);
    // A line split by a page break can be read by both ranges; only there is a repeat dropped.
    // Within one range two identical lines are two lines (the same part for two plants, say).
    const start = sorted.length && lastOfPrevious !== null && key(sorted[0]!) === lastOfPrevious ? 1 : 0;
    for (const line of sorted.slice(start)) lineItems.push({ ...line, lineNumber: lineItems.length + 1 });
    if (sorted.length) lastOfPrevious = key(sorted[sorted.length - 1]!);
  }
  return {
    header,
    lineItems,
    vendorIdentified: parts.map((p) => p.vendorIdentified).find(Boolean) ?? null,
  } as ExtractionResult;
}

/** The last spreadsheet row number in the extractor's text ("Row 158: ..."). */
export function sheetRowCount(sheetText: string): number {
  let max = 0;
  for (const m of sheetText.matchAll(/^Row (\d+):/gm)) max = Math.max(max, Number(m[1]));
  return max;
}

export const rowRangeNote = (from: number, to: number, rowCount: number, inRange?: number) => `---
This spreadsheet has ${rowCount} rows, so its line items are read a few rows at a time. In THIS request:
- Extract the header fields as usual, from wherever they are in the sheet.
- Return ONLY the line items in spreadsheet rows ${from} to ${to} (the "Row N" numbers, on every sheet). Return every one of them that qualifies under the spreadsheet rules, in order, and none from other rows.${
  inRange ? `
- Rows ${from} to ${to} hold ${inRange} non-empty row(s), counting any heading or note rows among them. Before answering, check that every item row among them is in your answer, one line item per row.` : ''
}
- Use the same column mapping as the spreadsheet rules give, so that every part of this sheet is read the same way.`;

/** How many non-empty rows ("Row N: ...") the extractor's text has between two row numbers. */
export function rowsBetween(sheetText: string, from: number, to: number): number {
  let n = 0;
  for (const m of sheetText.matchAll(/^Row (\d+):/gm)) if (+m[1]! >= from && +m[1]! <= to) n++;
  return n;
}

/**
 * Extract a document, in ranges when it is long: a PDF past `perCall` pages, or a spreadsheet
 * past `rowsPerCall` rows (asked for 154 schedule lines at once, the model returned 10). A
 * failure in any range fails the whole extraction, so a record never lands with lines missing.
 */
async function extractInRanges(
  provider: ExtractionProvider,
  req: ExtractionRequest,
  pageCount: number | null,
  perCall: number,
  rowsPerCall = 0,
): Promise<ExtractionResponse> {
  const rowCount = req.sheetText !== undefined ? sheetRowCount(req.sheetText) : 0;
  const ranges =
    req.sheetText !== undefined ? pageRanges(rowCount, rowsPerCall) : pageCount ? pageRanges(pageCount, perCall) : [];
  if (ranges.length === 0) return provider.extract(req);
  const note = (from: number, to: number) =>
    req.sheetText !== undefined ? rowRangeNote(from, to, rowCount, rowsBetween(req.sheetText, from, to)) : rangeNote(from, to, pageCount!);

  const answers: ExtractionResponse[] = [];
  for (const [from, to] of ranges) {
    const answer = await provider.extract({
      ...req,
      prompt: `${req.prompt}\n\n${note(from, to)}`,
      promptVersion: `${req.promptVersion}+${req.sheetText !== undefined ? 'rows' : 'pages'}`,
    }).catch((err) => {
      // A range with no qualifying line (every row zero) is not a failure of the document.
      if (/at least 1 element/.test(String((err as Error)?.message))) return null;
      throw err;
    });
    if (answer) answers.push(answer);
  }
  if (answers.length === 0) return provider.extract(req);
  const sum = (f: (a: ExtractionResponse) => number | null) =>
    answers.every((a) => f(a) === null) ? null : answers.reduce((n, a) => n + (f(a) ?? 0), 0);
  return {
    result: mergeRanges(answers.map((a) => a.result)),
    raw: { ranges: ranges.map(([from, to]) => ({ from, to })), responses: answers.map((a) => a.raw) },
    model: [...new Set(answers.map((a) => a.model))].join(', '),
    provider: answers[0]!.provider,
    latencyMs: answers.reduce((n, a) => n + a.latencyMs, 0),
    inputTokens: sum((a) => a.inputTokens),
    outputTokens: sum((a) => a.outputTokens),
  };
}

/** "0", "0.00", "0,000": a quantity written as zero. Blank is not zero. */
const isZero = (v: string | null | undefined) => !!v && /^[\s0.,]+$/.test(v) && /0/.test(v);

/**
 * A schedule lists every material, most with 0 in the month being ordered; asked to leave
 * those out, the model still returned 92 of them beside 37 real lines. So, for a spreadsheet,
 * once some lines carry a quantity, the lines whose quantity is written as 0 are dropped.
 * Lines with no quantity read are kept for the reviewer.
 */
export function dropZeroQuantityLines(result: ExtractionResult): ExtractionResult {
  const hasQty = result.lineItems.some((l) => l.quantity?.value && !isZero(l.quantity.value));
  if (!hasQty) return result;
  const kept = result.lineItems.filter((l) => !isZero(l.quantity?.value));
  if (kept.length === result.lineItems.length) return result;
  return { ...result, lineItems: kept.map((l, i) => ({ ...l, lineNumber: i + 1 })) };
}

/**
 * Extract a document, in ranges when it is long: a PDF past `perCall` pages, or a spreadsheet
 * past `rowsPerCall` rows. A spreadsheet's lines ordered at 0 are then left out.
 */
export async function extractByPages(
  provider: ExtractionProvider,
  req: ExtractionRequest,
  pageCount: number | null,
  perCall: number,
  rowsPerCall = 0,
): Promise<ExtractionResponse> {
  const res = await extractInRanges(provider, req, pageCount, perCall, rowsPerCall);
  if (req.sheetText === undefined) return res;
  return { ...res, result: clearPlaceholderPoNumber(clearSupplierCodes(dropZeroQuantityLines(res.result), req.sheetText)) };
}

/**
 * The values in the sheet's "Vendor" / "Supplier" columns: the codes the customer gives US.
 * Read from the extractor's text, where a heading row looks like "Row 1: A1=Purch.Doc. | F1=Vendor".
 */
export function supplierColumnValues(sheetText: string): Set<string> {
  const cols = new Set<string>();
  const values = new Set<string>();
  for (const line of sheetText.split('\n')) {
    for (const m of line.matchAll(/(?:^Row \d+: |\| )([A-Z]+)(\d+)(?:\(hidden\))?=([^|]*)/g)) {
      const [, col, , raw] = m;
      const value = raw!.trim();
      if (/^(vendor|supplier)(\s*(code|no\.?|number|id))?$/i.test(value)) cols.add(col!);
      else if (cols.has(col!) && value) values.add(value.toLowerCase());
    }
  }
  return values;
}

/**
 * A customer code read from the sheet that is really the supplier's code (Varroc's "Vendor"
 * column holds CBM0225, Varroc's code for Millennium) is cleared and marked for review: as a
 * customer code it would send the order to the wrong customer in SAP.
 */
export function clearSupplierCodes(result: ExtractionResult, sheetText: string): ExtractionResult {
  const code = result.header.customerCode?.value?.trim();
  if (!code || !supplierColumnValues(sheetText).has(code.toLowerCase())) return result;
  return { ...result, header: { ...result.header, customerCode: { value: null, confidence: 0.3 } } };
}

/**
 * A PO number with no digit in it ("PO in process", "TBD") is a note that the PO has not been
 * issued, not a PO number: it is cleared and marked for review, so it can never reach SAP as one.
 */
export function clearPlaceholderPoNumber(result: ExtractionResult): ExtractionResult {
  const po = result.header.poNumber?.value?.trim();
  if (!po || /\d/.test(po)) return result;
  return { ...result, header: { ...result.header, poNumber: { value: null, confidence: 0.3 } } };
}
