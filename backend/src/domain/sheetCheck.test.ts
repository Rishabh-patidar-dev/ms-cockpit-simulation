import { describe, expect, it } from 'vitest';
import { buildCellIndex, NOT_IN_SHEET, sheetValueIssues, valueInSheet } from './sheetCheck.js';
import type { HeaderWithLines } from './validation.js';

// A made-up supply schedule, as the spreadsheet reader gives it.
const index = buildCellIndex([
  'SUPPLY SCHEDULE', 'EXW', '90 days',
  'SAP code', 'Description', 'PO 2026-118 (06.10.2026)',
  'PRT2040011', 'Resistor 10K 0603', '260000', '0.0007',
  'PRT3050011', 'Thyristor 40A', '27000', '0.30720000000000003',
  '8294.4', 'NOS', 'USD 1.234,50',
]);

describe('valueInSheet', () => {
  it('finds a code only as a whole value, so a one-digit misread is caught', () => {
    expect(valueInSheet('PRT2040011', index)).toBe(true);
    expect(valueInSheet('PRT2040010', index)).toBe(false);
    expect(valueInSheet('PRT204001', index)).toBe(false);
  });

  it('matches numbers however they are written, including float noise in a calculated cell', () => {
    expect(valueInSheet('27000', index)).toBe(true);
    expect(valueInSheet('27,000', index)).toBe(true);
    expect(valueInSheet('27000.00', index)).toBe(true);
    expect(valueInSheet('0.3072', index)).toBe(true);
    expect(valueInSheet('8.294,40', index)).toBe(true);
    expect(valueInSheet('270000', index)).toBe(false);
    expect(valueInSheet('0.0008', index)).toBe(false);
  });

  it('finds text inside a longer cell on word edges, ignoring case and spacing', () => {
    expect(valueInSheet('2026-118 (06.10.2026)', index)).toBe(true);
    expect(valueInSheet('po 2026-118  (06.10.2026)', index)).toBe(true);
    expect(valueInSheet('nos', index)).toBe(true);
    expect(valueInSheet('USD', index)).toBe(true);
    expect(valueInSheet('INR', index)).toBe(false);
  });
});

const line = (lineNumber: number, over: Record<string, string | null>) =>
  ({ lineNumber, materialCode: null, customerMaterialNumber: null, description: null, quantity: null, uom: null, unitPrice: null, lineNetValue: null, deliveryDate: null, plant: null, ...over }) as unknown as HeaderWithLines['lineItems'][number];

const header = (lines: HeaderWithLines['lineItems'], over: Record<string, string | null> = {}) =>
  ({ poNumber: 'PO 2026-118 (06.10.2026)', poDate: '06.10.2026', customerCode: null, currency: null, poTotalValue: null, lineItems: lines, ...over }) as unknown as HeaderWithLines;

describe('sheetValueIssues', () => {
  it('warns on the misread material and nothing else', () => {
    const issues = sheetValueIssues(
      header([
        line(1, { materialCode: 'PRT3050011', quantity: '27000', unitPrice: '0.3072', uom: 'NOS' }),
        line(2, { materialCode: 'PRT2040010', quantity: '260000', unitPrice: '0.0007', description: 'anything, descriptions are not checked' }),
      ]),
      index,
      new Set(),
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: NOT_IN_SHEET, severity: 'WARNING', fieldPath: 'line.2.materialCode', message: expect.stringContaining('"PRT2040010"') }),
    ]);
  });

  it('leaves alone what a reviewer typed in, and dates', () => {
    const issues = sheetValueIssues(
      header([line(1, { materialCode: 'PRT3050011', uom: 'EA' })], { customerCode: 'C-1001', currency: 'INR', poDate: '2026-10-06' }),
      index,
      new Set(['header.customerCode', 'header.currency', 'line.1.uom']),
    );
    expect(issues).toEqual([]);
  });

  it('flags a value the reader made up, such as a currency the sheet never names', () => {
    const issues = sheetValueIssues(header([], { currency: 'INR' }), index, new Set());
    expect(issues.map((i) => i.fieldPath)).toEqual(['header.currency']);
  });

  it('has nothing to say before anything is read', () => {
    expect(sheetValueIssues(null, index, new Set())).toEqual([]);
  });
});
