import { describe, expect, it } from 'vitest';
import { cleanExtraction, documentGroupSeparator } from './cleanExtraction.js';
import { HEADER_FIELDS, LINE_FIELDS, type ExtractionResult } from './types.js';

const cv = (value: string | null) => ({ value, confidence: value === null ? null : 0.99 });

function result(lines: Partial<Record<(typeof LINE_FIELDS)[number], string | null>>[], total: string | null = null): ExtractionResult {
  return {
    header: {
      ...(Object.fromEntries(HEADER_FIELDS.map((f) => [f, cv(null)])) as ExtractionResult['header']),
      poTotalValue: cv(total),
    },
    lineItems: lines.map((l, i) => ({
      lineNumber: i + 1,
      ...(Object.fromEntries(LINE_FIELDS.map((f) => [f, cv(l[f] ?? null)])) as Omit<ExtractionResult['lineItems'][number], 'lineNumber'>),
    })),
  };
}

const full = { materialCode: 'MS-1', quantity: '4,000', uom: 'EA', unitPrice: '0.18', lineNetValue: '720.00' };

describe('cleanExtraction: empty lines', () => {
  it('drops lines with no value at all (a total row read as a line)', () => {
    const out = cleanExtraction(result([full, {}, {}]));
    expect(out.lineItems).toHaveLength(1);
  });

  it('keeps a line that has even one value', () => {
    const out = cleanExtraction(result([full, { description: 'Freight' }]));
    expect(out.lineItems).toHaveLength(2);
  });

  it('keeps the lines when every one is empty, so the reviewer sees the problem', () => {
    expect(cleanExtraction(result([{}, {}])).lineItems).toHaveLength(2);
  });
});

describe('cleanExtraction: thousands separators', () => {
  it('reads "4,000" as 4000 when the document prints "3,360.00"', () => {
    const out = cleanExtraction(result([full, { ...full, quantity: '3,000', lineNetValue: '3,360.00' }], '4,080.00'));
    expect(out.lineItems.map((l) => l.quantity.value)).toEqual(['4000', '3000']);
    expect(out.lineItems[1]!.lineNetValue.value).toBe('3,360.00'); // not ambiguous, left as printed
  });

  it('reads "1.200" as 1200 in a document that prints "1.234,56"', () => {
    const out = cleanExtraction(result([{ ...full, quantity: '1.200', unitPrice: '9,40', lineNetValue: '11.280,00' }]));
    expect(out.lineItems[0]!.quantity.value).toBe('1200');
  });

  it('changes nothing when the document gives no evidence', () => {
    const out = cleanExtraction(result([{ ...full, lineNetValue: '720' }]));
    expect(out.lineItems[0]!.quantity.value).toBe('4,000');
  });

  it('changes nothing when the document shows both conventions', () => {
    const out = cleanExtraction(result([full, { ...full, lineNetValue: '3,360.00' }, { ...full, lineNetValue: '1.234,56' }]));
    expect(out.lineItems[0]!.quantity.value).toBe('4,000');
  });

  it('leaves a three-place decimal written with the decimal mark alone', () => {
    const out = cleanExtraction(result([{ ...full, unitPrice: '0.125', lineNetValue: '1,500.00' }]));
    expect(out.lineItems[0]!.unitPrice.value).toBe('0.125');
  });
});

describe('documentGroupSeparator', () => {
  it.each([
    [['3,360.00'], ','],
    [['1.234,56'], '.'],
    [['1,200,000'], ','],
    [['1.200.000'], '.'],
    [['4,000', '720'], null],
    [['3,360.00', '1.234,56'], null],
  ] as const)('%j → %s', (values, expected) => {
    expect(documentGroupSeparator([...values])).toBe(expected);
  });
});
