import { beforeEach, describe, expect, it, vi } from 'vitest';

// What is sent to Gemini (a PDF as the file, a spreadsheet as its cells in text), and how a
// "high demand" or quota answer is waited out, on the fallback model, before it counts as a failure.

const calls: { model: string; parts: Record<string, unknown>[]; thinking: unknown }[] = [];
let answers: (() => unknown)[] = [];
const { HEADER_FIELDS, LINE_FIELDS } = await import('../../domain/types.js');
const blank = (fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, { value: null, confidence: 1 }]));
const validResult = { header: blank(HEADER_FIELDS), lineItems: [{ lineNumber: 1, ...blank(LINE_FIELDS) }] };
const ok = () => ({ text: JSON.stringify(validResult), usageMetadata: {} });
const busy = () => {
  throw Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}'), { status: 503 });
};
const missing = () => {
  throw Object.assign(new Error('{"error":{"code":404,"status":"NOT_FOUND"}}'), { status: 404 });
};

vi.mock('@google/genai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    models = {
      generateContent: async (req: { model: string; contents: { parts: Record<string, unknown>[] }[]; config: { thinkingConfig?: unknown } }) => {
        calls.push({ model: req.model, parts: req.contents[0]!.parts, thinking: req.config.thinkingConfig });
        return (answers.shift() ?? ok)();
      },
    };
  }
  return { ...real, GoogleGenAI };
});

const { env } = await import('../../config/env.js');
const { GeminiExtractionProvider, isOverloaded, overloadWaitMs, thinkingFor } = await import('./gemini.js');

const pdfReq = { document: Buffer.from('%PDF-1.4'), prompt: 'P', promptVersion: 'v', timeoutMs: 1000 };
const sheetReq = { ...pdfReq, document: Buffer.from('PK\x03\x04'), sheetText: 'Row 1: A1=PO | B1=77' };
const noSleep = vi.fn(async (_ms: number) => {});

beforeEach(() => {
  calls.length = 0;
  answers = [];
  noSleep.mockClear();
  Object.assign(env, { GEMINI_MODEL: 'gemini-3.6-flash', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash', EXTRACTION_OVERLOAD_RETRIES: 4 });
});

describe('what is sent', () => {
  it('sends a PDF as an inline file, with the model thinking as usual', async () => {
    await new GeminiExtractionProvider('key').extract(pdfReq, noSleep);
    expect(calls[0]!.parts[0]).toMatchObject({ inlineData: { mimeType: 'application/pdf' } });
    expect(calls[0]!.parts[1]).toEqual({ text: 'P' });
    expect(calls[0]!.thinking).toBeUndefined();
  });

  it('sends a spreadsheet as its cells in text, never the workbook bytes, and asks for little thinking', async () => {
    await new GeminiExtractionProvider('key').extract(sheetReq, noSleep);
    expect(calls[0]!.parts[0]).toEqual({ text: expect.stringContaining('Row 1: A1=PO | B1=77') });
    expect(JSON.stringify(calls[0]!.parts)).not.toContain('inlineData');
    expect(calls[0]!.thinking).toEqual({ thinkingLevel: 'LOW' });
  });
});

describe('overload', () => {
  it('waits out "high demand", alternating with the fallback model, and reports the model that answered', async () => {
    answers = [busy, busy, ok];
    const r = await new GeminiExtractionProvider('key').extract(sheetReq, noSleep);
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.6-flash']);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([10_000, 20_000]);
    expect(r.model).toBe('gemini-3.6-flash');
  });

  it('gives up after the configured number of waits, with Gemini\'s reason', async () => {
    answers = Array(10).fill(busy);
    await expect(new GeminiExtractionProvider('key').extract(pdfReq, noSleep)).rejects.toThrow(/high demand/);
    expect(calls).toHaveLength(5);
  });

  it('drops a fallback model this key cannot use, without counting it as a failure', async () => {
    answers = [busy, missing, ok];
    const r = await new GeminiExtractionProvider('key').extract(pdfReq, noSleep);
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.6-flash']);
    expect(r.model).toBe('gemini-3.6-flash');
  });

  it('does not wait on an error that retrying the same request cannot fix', async () => {
    answers = [() => { throw Object.assign(new Error('{"error":{"code":400,"message":"bad request"}}'), { status: 400 }); }];
    await expect(new GeminiExtractionProvider('key').extract(pdfReq, noSleep)).rejects.toThrow(/bad request/);
    expect(calls).toHaveLength(1);
    expect(noSleep).not.toHaveBeenCalled();
  });
});

it('recognises Gemini\'s overload and quota answers', () => {
  expect(isOverloaded({ status: 429 })).toBe(true);
  expect(isOverloaded(new Error('Gemini request failed: {"error":{"code":503,"status":"UNAVAILABLE"}}'))).toBe(true);
  expect(isOverloaded(new Error('You exceeded your current quota'))).toBe(true);
  expect(isOverloaded(new Error('This operation was aborted'))).toBe(false);
  expect([1, 2, 3, 4, 5].map(overloadWaitMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
});

it('asks Gemini 2.5 for a thinking budget rather than a level', () => {
  expect(thinkingFor('gemini-2.5-flash', true)).toEqual({ thinkingBudget: 512 });
  expect(thinkingFor('gemini-3.6-flash', true)).toEqual({ thinkingLevel: 'LOW' });
  expect(thinkingFor('gemini-3.6-flash', false)).toBeUndefined();
});
