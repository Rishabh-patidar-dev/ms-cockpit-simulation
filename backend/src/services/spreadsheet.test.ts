import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { columnLetter, detectDelimiter, parseCsv, readCsv, readXlsx, workbookToText } from './spreadsheet.js';

/** A small supply schedule shaped like the ones customers send: title, terms, a table, hidden history. */
async function scheduleWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Schedule');
  ws.getCell('A1').value = 'SUPPLY SCHEDULE';
  ws.mergeCells('A1:F1');
  ws.getCell('A2').value = 'Payment terms';
  ws.getCell('C2').value = '60 days';
  ws.getRow(4).values = ['Part', 'Description', 'Price', 'Old PO 101', 'PO 102 (01.10.2026)', 'Value'];
  ws.getRow(5).values = ['P-1', 'Resistor\n10K', 0.1 + 0.2, 500, 1000, null];
  ws.getCell('F5').value = { formula: 'C5*E5', result: 300.00000000000006 };
  ws.getRow(6).values = ['P-2', { richText: [{ text: 'Cap ' }, { text: '1nF' }] }, 0.5, 200, 400, null];
  ws.getCell('F6').value = { formula: 'C6*E6', result: 200 };
  ws.getCell('G7').value = new Date(Date.UTC(2026, 9, 6));
  ws.getColumn(4).hidden = true;
  wb.addWorksheet('Lookup', { state: 'hidden' }).addRow(['secret']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('readXlsx', () => {
  it('reads values as Excel shows them: formula results, rich text, dates, no float noise', async () => {
    const { sheets } = await readXlsx(await scheduleWorkbook());
    const s = sheets[0]!;
    expect(s.name).toBe('Schedule');
    expect(s.rows[4]).toEqual(['P-1', 'Resistor\n10K', '0.3', '500', '1000', '300', '']);
    expect(s.rows[5]?.slice(0, 6)).toEqual(['P-2', 'Cap 1nF', '0.5', '200', '400', '200']);
    expect(s.rows[6]?.[6]).toBe('2026-10-06');
  });

  it('keeps a merged value once, in its first cell', async () => {
    const { sheets } = await readXlsx(await scheduleWorkbook());
    expect(sheets[0]!.rows[0]).toEqual(['SUPPLY SCHEDULE', '', '', '', '', '', '']);
    expect(sheets[0]!.merges).toEqual(['A1:F1']);
  });

  it('notes hidden sheets and columns', async () => {
    const { sheets } = await readXlsx(await scheduleWorkbook());
    expect(sheets.map((s) => [s.name, s.hidden])).toEqual([
      ['Schedule', false],
      ['Lookup', true],
    ]);
    expect(sheets[0]!.hiddenColumns).toEqual([4]);
  });

  it('refuses bytes that are not a workbook, with a reason', async () => {
    await expect(readXlsx(Buffer.from('PK\x03\x04 broken xl/workbook.xml'))).rejects.toThrow(/could not be opened/);
  });
});

describe('workbookToText', () => {
  it('gives every value its cell reference, marks hidden cells, and leaves hidden sheets out', async () => {
    const text = workbookToText(await readXlsx(await scheduleWorkbook()));
    expect(text).toContain('### Sheet 1 of 1: "Schedule"');
    expect(text).toContain('Row 2: A2=Payment terms | C2=60 days');
    expect(text).toContain('Row 5: A5=P-1 | B5=Resistor 10K | C5=0.3 | D5(hidden)=500 | E5=1000 | F5=300');
    expect(text).toContain('Hidden columns: D');
    expect(text).toContain('Hidden sheets not included: "Lookup".');
    expect(text).not.toContain('secret');
  });
});

describe('CSV', () => {
  it('finds the delimiter European Excel uses', () => {
    expect(detectDelimiter('Part;Qty;Price\nA;1;2,50\n')).toBe(';');
    expect(detectDelimiter('Part,Qty\nA,1\n')).toBe(',');
    expect(detectDelimiter('Part\tQty\nA\t1\n')).toBe('\t');
  });

  it('keeps quoted delimiters, doubled quotes and line breaks inside a field', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\nlines"\r\nx,y,z,w', ',')).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\nlines'],
      ['x', 'y', 'z', 'w'],
    ]);
  });

  it('reads Windows-1252 and a UTF-8 byte-order mark', () => {
    const latin = readCsv(Buffer.from([0x50, 0x2c, 0x51, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31]));
    expect(latin.sheets[0]!.rows).toEqual([['P', 'Q'], ['Café', '1']]);
    const bom = readCsv(Buffer.from('﻿Part,Qty\nA,1\n'));
    expect(bom.sheets[0]!.rows[0]).toEqual(['Part', 'Qty']);
  });
});

it('names columns past Z the way Excel does', () => {
  expect([1, 26, 27, 44, 703].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AR', 'AAA']);
});
