import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { detectDocumentKind, kindOfMimeType, MIME_TYPES, unsupportedReason } from './documentKind.js';

const xlsxBytes = async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('PO').addRow(['PO number', 'PO-1']);
  return Buffer.from(await wb.xlsx.writeBuffer());
};

describe('detectDocumentKind', () => {
  it('tells PDF and Excel apart by their bytes, whatever the name says', async () => {
    expect(detectDocumentKind(Buffer.from('%PDF-1.7 ...'), 'po.xlsx')).toBe('pdf');
    expect(detectDocumentKind(await xlsxBytes(), 'po.pdf')).toBe('xlsx');
  });

  it('refuses a zip that is not a workbook, such as a Word file', () => {
    expect(detectDocumentKind(Buffer.from('PK\x03\x04word/document.xml'), 'po.xlsx')).toBeNull();
  });

  it('takes a CSV only when it is named .csv and is plain text', () => {
    expect(detectDocumentKind(Buffer.from('Part;Qty\nA-1;10\n'), 'PO.CSV')).toBe('csv');
    expect(detectDocumentKind(Buffer.from('Part;Qty\nA-1;10\n'), 'po.txt')).toBeNull();
    expect(detectDocumentKind(Buffer.from([0x50, 0, 0x51]), 'po.csv')).toBeNull();
    // Windows-1252, as Excel on Windows writes it, is text too.
    expect(detectDocumentKind(Buffer.from([0x50, 0x6f, 0x73, 0xe9, 0x0a]), 'po.csv')).toBe('csv');
  });

  it('explains an old .xls workbook rather than calling it unknown', () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detectDocumentKind(xls, 'po.xls')).toBeNull();
    expect(unsupportedReason(xls, 'po.xls')).toMatch(/save it as \.xlsx/);
    expect(unsupportedReason(Buffer.from('hello'), 'notes.txt')).toMatch(/not a PDF, an Excel workbook/);
  });

  it('reads the stored MIME type back, with older records counting as PDF', () => {
    expect(kindOfMimeType(MIME_TYPES.xlsx)).toBe('xlsx');
    expect(kindOfMimeType('text/csv')).toBe('csv');
    expect(kindOfMimeType('application/pdf')).toBe('pdf');
    expect(kindOfMimeType(undefined)).toBe('pdf');
  });
});
