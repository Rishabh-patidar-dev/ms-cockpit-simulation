import { describe, expect, it, vi } from 'vitest';

// What is sent to Gemini: a PDF goes as the file, a spreadsheet as its cells in text.

const calls: unknown[] = [];
vi.mock('@google/genai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    models = {
      generateContent: async (req: unknown) => {
        calls.push(req);
        return { text: JSON.stringify({ header: {}, lineItems: [] }), usageMetadata: {} };
      },
    };
  }
  return { ...real, GoogleGenAI };
});

const { GeminiExtractionProvider } = await import('./gemini.js');

const partsOf = (req: unknown) => (req as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;

describe('GeminiExtractionProvider', () => {
  it('sends a PDF as an inline file', async () => {
    calls.length = 0;
    await new GeminiExtractionProvider('key').extract({ document: Buffer.from('%PDF-1.4'), prompt: 'P', promptVersion: 'v', timeoutMs: 1000 }).catch(() => undefined);
    const parts = partsOf(calls[0]);
    expect(parts[0]).toMatchObject({ inlineData: { mimeType: 'application/pdf' } });
    expect(parts[1]).toEqual({ text: 'P' });
  });

  it('sends a spreadsheet as its cells in text, never the workbook bytes', async () => {
    calls.length = 0;
    await new GeminiExtractionProvider('key')
      .extract({ document: Buffer.from('PK\x03\x04'), sheetText: 'Row 1: A1=PO | B1=77', prompt: 'P', promptVersion: 'v', timeoutMs: 1000 })
      .catch(() => undefined);
    const parts = partsOf(calls[0]);
    expect(parts[0]).toEqual({ text: expect.stringContaining('Row 1: A1=PO | B1=77') });
    expect(JSON.stringify(parts)).not.toContain('inlineData');
  });
});
