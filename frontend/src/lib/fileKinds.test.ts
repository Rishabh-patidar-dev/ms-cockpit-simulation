import { describe, expect, it } from 'vitest';
import { isSpreadsheetType, refusalFor } from './fileKinds';

describe('refusalFor', () => {
  it('lets PDFs, workbooks and CSVs through, and files with no stated type', () => {
    expect(refusalFor({ name: 'po.pdf', type: 'application/pdf' })).toBeNull();
    expect(refusalFor({ name: 'po.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBeNull();
    expect(refusalFor({ name: 'po.csv', type: 'text/csv' })).toBeNull();
    expect(refusalFor({ name: 'po.csv', type: 'application/vnd.ms-excel' })).toBeNull();
    expect(refusalFor({ name: 'scan', type: '' })).toBeNull();
  });

  it('turns away other files, and asks for .xlsx in place of .xls', () => {
    expect(refusalFor({ name: 'photo.png', type: 'image/png' })).toMatch(/not a PDF, an Excel workbook/);
    expect(refusalFor({ name: 'old.xls', type: 'application/vnd.ms-excel' })).toMatch(/Save it as \.xlsx/);
  });
});

it('recognises a stored spreadsheet by its MIME type', () => {
  expect(isSpreadsheetType('text/csv')).toBe(true);
  expect(isSpreadsheetType('application/pdf')).toBe(false);
  expect(isSpreadsheetType(undefined)).toBe(false);
});
