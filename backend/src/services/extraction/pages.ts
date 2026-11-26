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

/**
 * Extract a document, in page ranges when it is a long PDF. A failure in any range fails the
 * whole extraction (with that range's error), so a record never lands with lines missing.
 */
export async function extractByPages(
  provider: ExtractionProvider,
  req: ExtractionRequest,
  pageCount: number | null,
  perCall: number,
): Promise<ExtractionResponse> {
  const ranges = req.sheetText === undefined && pageCount ? pageRanges(pageCount, perCall) : [];
  if (ranges.length === 0) return provider.extract(req);

  const answers: ExtractionResponse[] = [];
  for (const [from, to] of ranges) {
    answers.push(
      await provider.extract({
        ...req,
        prompt: `${req.prompt}\n\n${rangeNote(from, to, pageCount!)}`,
        promptVersion: `${req.promptVersion}+pages`,
      }),
    );
  }
  const sum = (f: (a: ExtractionResponse) => number | null) =>
    answers.every((a) => f(a) === null) ? null : answers.reduce((n, a) => n + (f(a) ?? 0), 0);
  return {
    result: mergeRanges(answers.map((a) => a.result)),
    raw: { pages: ranges.map(([from, to], i) => ({ from, to, response: answers[i]!.raw })) },
    model: [...new Set(answers.map((a) => a.model))].join(', '),
    provider: answers[0]!.provider,
    latencyMs: answers.reduce((n, a) => n + a.latencyMs, 0),
    inputTokens: sum((a) => a.inputTokens),
    outputTokens: sum((a) => a.outputTokens),
  };
}
