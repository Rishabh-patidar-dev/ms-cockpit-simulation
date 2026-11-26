import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { detectDocument, documentPreview, extractionParts } from './index.js';
import { readXlsx, sheetsToText } from './xlsx.js';

/** A minimal zip (deflated entries) — enough to stand in for an .xlsx in a test. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(text.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const workbook = () =>
  zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Schedule" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>BO Code</t></si><si><t>Qty</t></si><si><r><t>CHIPCAP </t></r><r><t>220NF &amp; 50V</t></r></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>0.29930000000000001</v></c><c r="D3" t="inlineStr"><is><t>Oct 26</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });

describe('detectDocument', () => {
  it('goes by content, not by name', () => {
    expect(detectDocument(Buffer.from('%PDF-1.7 ...'), 'order.xlsx')).toMatchObject({ kind: 'pdf' });
    expect(detectDocument(workbook(), 'order.pdf')).toMatchObject({ kind: 'xlsx', ext: 'xlsx' });
    expect(detectDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'x')).toMatchObject({ kind: 'image', mimeType: 'image/png' });
  });

  it('takes text as CSV only when it is named so', () => {
    expect(detectDocument(Buffer.from('PO,Qty\n1,2\n'), 'po.csv')).toMatchObject({ kind: 'csv' });
    expect(detectDocument(Buffer.from('PO,Qty\n1,2\n'), 'po.exe')).toHaveProperty('error');
  });

  it('refuses an old .xls with a way forward', () => {
    const ole = Buffer.alloc(1024);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole);
    const res = detectDocument(ole, 'schedule.xls');
    expect(res).toHaveProperty('error');
    expect((res as { error: string }).error).toMatch(/save it as \.xlsx/);
  });

  it('refuses a zip that is not a workbook', () => {
    expect(detectDocument(zip({ 'readme.txt': 'hi' }), 'a.zip')).toHaveProperty('error');
  });
});

describe('readXlsx', () => {
  it('reads shared, inline and numeric cells, keeping columns and row numbers', () => {
    const sheets = readXlsx(workbook());
    expect(sheets.map((s) => [s.name, s.hidden])).toEqual([['Schedule', false], ['Old', true]]);
    expect(sheets[0]!.rows).toEqual([
      ['BO Code', '', 'Qty'],
      [],
      ['CHIPCAP 220NF & 50V', '', '0.2993', 'Oct 26'],
    ]);
    expect(sheetsToText(sheets)).toContain('R3: CHIPCAP 220NF & 50V |  | 0.2993 | Oct 26');
    expect(sheetsToText(sheets)).toContain('### Sheet "Old" (hidden)\n(empty)');
  });
});

describe('extractionParts', () => {
  it('sends a PDF as a file and a spreadsheet as text', () => {
    const pdf = Buffer.from('%PDF-1.4 x');
    expect(extractionParts(pdf, 'a.pdf')).toEqual([{ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } }]);
    const [part] = extractionParts(workbook(), 'sched.xlsx');
    expect(part).toHaveProperty('text');
    expect((part as { text: string }).text).toContain('Spreadsheet "sched.xlsx"');
  });

  it('previews a CSV as text and a PDF as nothing', () => {
    expect(documentPreview(Buffer.from('a,b\n1,2'), 'x.csv').text).toContain('a,b\n1,2');
    expect(documentPreview(Buffer.from('%PDF-1.4'), 'x.pdf')).toEqual({ kind: 'pdf', text: '' });
  });
});
