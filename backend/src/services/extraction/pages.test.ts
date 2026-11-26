import { describe, expect, it } from 'vitest';
import { HEADER_FIELDS, LINE_FIELDS, type ExtractionResult } from '../../domain/types.js';
import { extractByPages, mergeRanges, pageRanges } from './pages.js';
import type { ExtractionProvider, ExtractionRequest } from './types.js';

const cell = (value: string | null) => ({ value, confidence: 0.9 });
const header = (over: Record<string, string | null> = {}) =>
  Object.fromEntries(HEADER_FIELDS.map((f) => [f, cell(over[f] ?? null)])) as ExtractionResult['header'];
const line = (n: number, code: string, plant: string | null = null) => ({
  lineNumber: n,
  ...Object.fromEntries(LINE_FIELDS.map((f) => [f, cell(null)])),
  materialCode: cell(code),
  plant: cell(plant),
}) as ExtractionResult['lineItems'][number];
const result = (lines: ExtractionResult['lineItems'], h = header()): ExtractionResult => ({ header: h, lineItems: lines, vendorIdentified: null }) as ExtractionResult;

describe('pageRanges', () => {
  it('leaves a short PDF whole, and splits a long one into even ranges', () => {
    expect(pageRanges(6, 6)).toEqual([]);
    expect(pageRanges(11, 6)).toEqual([[1, 6], [7, 11]]);
    expect(pageRanges(36, 6)).toHaveLength(6);
    expect(pageRanges(36, 0)).toEqual([]);
  });

  it('widens the ranges rather than make more than ten requests', () => {
    const r = pageRanges(200, 6);
    expect(r).toHaveLength(10);
    expect(r[0]).toEqual([1, 20]);
    expect(r[9]).toEqual([181, 200]);
  });
});

describe('mergeRanges', () => {
  it('keeps the lines in page order, renumbered, and takes each header value from the first range that has it', () => {
    const m = mergeRanges([
      result([line(10, 'A'), line(20, 'B')], header({ poNumber: '55' })),
      result([line(30, 'C')], header({ poTotalValue: '100.00' })),
    ]);
    expect(m.lineItems.map((l) => [l.lineNumber, l.materialCode.value])).toEqual([[1, 'A'], [2, 'B'], [3, 'C']]);
    expect([m.header.poNumber.value, m.header.poTotalValue.value]).toEqual(['55', '100.00']);
  });

  it('drops a line read by both ranges at a page break, but never two lines within one range', () => {
    const m = mergeRanges([
      result([line(1, 'A', '1106'), line(2, 'A', '1106')]),
      result([line(2, 'A', '1106'), line(3, 'B')]),
    ]);
    expect(m.lineItems.map((l) => l.materialCode.value)).toEqual(['A', 'A', 'B']);
  });
});

describe('extractByPages', () => {
  const req: ExtractionRequest = { document: Buffer.from('%PDF'), prompt: 'P', promptVersion: 'v', timeoutMs: 1 };

  it('asks once per range, naming the pages, and puts the answers together', async () => {
    const prompts: string[] = [];
    const provider: ExtractionProvider = {
      name: 'fake',
      async extract(r) {
        prompts.push(r.prompt);
        const n = prompts.length;
        return { result: result([line(n, `M${n}`)]), raw: {}, model: 'm', provider: 'fake', latencyMs: 5, inputTokens: 1, outputTokens: 2 };
      },
    };
    const res = await extractByPages(provider, req, 11, 6);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('pages 1 to 6');
    expect(prompts[1]).toContain('pages 7 to 11');
    expect(res.result.lineItems.map((l) => l.materialCode.value)).toEqual(['M1', 'M2']);
    expect([res.latencyMs, res.inputTokens, res.outputTokens]).toEqual([10, 2, 4]);
  });

  it('sends a short PDF or a spreadsheet in one request, unchanged', async () => {
    const seen: ExtractionRequest[] = [];
    const provider: ExtractionProvider = {
      name: 'fake',
      async extract(r) {
        seen.push(r);
        return { result: result([line(1, 'A')]), raw: {}, model: 'm', provider: 'fake', latencyMs: 1, inputTokens: null, outputTokens: null };
      },
    };
    await extractByPages(provider, req, 3, 6);
    await extractByPages(provider, { ...req, sheetText: 'Row 1: A1=x' }, null, 6);
    expect(seen.map((r) => r.prompt)).toEqual(['P', 'P']);
  });
});

describe('countPdfPages', async () => {
  const { countPdfPages } = await import('../storage.js');
  it("takes the page tree's /Count over counting page objects, which overcounts old revisions", () => {
    const pages = Array.from({ length: 23 }, () => '<< /Type /Page >>').join('\n');
    expect(countPdfPages(Buffer.from(`%PDF-1.4\n<< /Type /Pages /Count 12 /Kids [] >>\n${pages}`))).toBe(12);
    expect(countPdfPages(Buffer.from(`%PDF-1.4\n${pages}`))).toBe(23);
    expect(countPdfPages(Buffer.from('%PDF-1.4'))).toBeNull();
  });
});

describe('a large spreadsheet', () => {
  it('is read 40 rows per request, a range with no qualifying line costing nothing', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => `Row ${i + 1}: A${i + 1}=x`).join('\n');
    const prompts: string[] = [];
    const provider: ExtractionProvider = {
      name: 'fake',
      async extract(r) {
        prompts.push(r.prompt);
        if (prompts.length === 2) throw new Error('Gemini response did not match the extraction schema: lineItems Array must contain at least 1 element(s)');
        return { result: result([line(1, `M${prompts.length}`)]), raw: {}, model: 'm', provider: 'fake', latencyMs: 1, inputTokens: null, outputTokens: null };
      },
    };
    const res = await extractByPages(provider, { document: Buffer.from('PK'), sheetText: rows, prompt: 'P', promptVersion: 'v', timeoutMs: 1 }, null, 6, 40);
    expect(prompts.map((p) => p.match(/rows (\d+) to (\d+)/)?.slice(1).join('-'))).toEqual(['1-40', '41-80', '81-100']);
    expect(res.result.lineItems.map((l) => l.materialCode.value)).toEqual(['M1', 'M3']);
  });
});
