import { describe, expect, it } from 'vitest';
import { expandPoFile, splitByPoNumber } from './poSplit.js';

// The SAP team's flat file, as sent: one row per item, two POs.
const sapCsv = Buffer.from(
  [
    'PO_NUMBER,COMPANY_CODE,DOC_TYPE,CREATED_DATE,CREATED_BY,PO_ITEM,MATERIAL,PLANT,STORAGE_LOCATION,DOC_DATE,DELIVERY_DATE,CURRENCY,QUANTITY,NET_PRICE,NET_VALUE,SHORT_TEXT,ORDER_UNIT,STATUS',
    '6100000019,1710,TA,25.09.2026,SAP,1,FG111_A,1710,171A,25.09.2026,31.12.2026,INR,100,50000,50000,,LM,OPEN',
    '6100000018,1710,TA,01.11.2026,SAP,2,FG228,1710,171B,23.09.2026,12.12.2026,USD,200,110,11000,,ST,OPEN',
    '',
  ].join('\n'),
);
const csv = (text: string) => Buffer.from(text);

describe('splitByPoNumber', () => {
  it("splits SAP's flat file into one CSV per PO number, heading row kept, rows unchanged", async () => {
    const parts = await splitByPoNumber(sapCsv, 'csv', 'SAP_PO_test3.csv');
    expect(parts?.map((p) => [p.poNumber, p.name])).toEqual([
      ['6100000019', 'SAP_PO_test3 - PO 6100000019.csv'],
      ['6100000018', 'SAP_PO_test3 - PO 6100000018.csv'],
    ]);
    const first = parts![0]!.content.toString().split('\r\n');
    expect(first[0]).toMatch(/^PO_NUMBER,COMPANY_CODE,/);
    expect(first[1]).toMatch(/^6100000019,1710,TA,25\.09\.2026,SAP,1,FG111_A,/);
    expect(first).toHaveLength(3); // heading, one row, final line break
  });

  it('keeps a file with one PO, several lines, as it is', async () => {
    expect(await splitByPoNumber(csv('PO No,Material,Qty\n55,A,1\n55,B,2\n'), 'csv', 'po.csv')).toBeNull();
  });

  it('leaves alone a sheet with no PO-number heading, a gap in the column, or too many POs (a schedule)', async () => {
    expect(await splitByPoNumber(csv('Material,Qty\nA,1\nB,2\n'), 'csv', 'a.csv')).toBeNull();
    expect(await splitByPoNumber(csv('PO_NUMBER,Qty\n1,1\n,2\n2,3\n'), 'csv', 'b.csv')).toBeNull();
    const many = ['Purch.Doc.,Qty', ...Array.from({ length: 11 }, (_, i) => `55${i},1`)].join('\n');
    expect(await splitByPoNumber(csv(many), 'csv', 'c.csv')).toBeNull();
  });

  it('finds the heading row below a title', async () => {
    const parts = await splitByPoNumber(csv('Open orders\n\nPO Number,Qty\nA1,1\nB2,2\n'), 'csv', 'd.csv');
    expect(parts?.map((p) => p.poNumber)).toEqual(['A1', 'B2']);
    expect(parts![1]!.content.toString()).toBe('Open orders\r\n\r\nPO Number,Qty\r\nB2,2\r\n');
  });
});

describe('expandPoFile', () => {
  it('passes a PDF through, and marks each part of a split file with where it came from', async () => {
    const pdf = { buffer: Buffer.from('%PDF-1.4'), originalname: 'po.pdf', mimetype: 'application/pdf' };
    expect(await expandPoFile(pdf)).toEqual([pdf]);
    const parts = await expandPoFile({ buffer: sapCsv, originalname: 'SAP_PO_test3.csv', mimetype: 'text/csv' });
    expect(parts.map((p) => [p.mimetype, p.splitFrom])).toEqual([
      ['text/csv', { file: 'SAP_PO_test3.csv', poNumber: '6100000019', of: 2, lines: 1 }],
      ['text/csv', { file: 'SAP_PO_test3.csv', poNumber: '6100000018', of: 2, lines: 1 }],
    ]);
  });
});

describe('a delivery schedule', () => {
  const schedule = [
    "Purch.Doc.,QUANTITY,Doc. Date,BO code,Short Text,Oct'26 Firm Plan,Nov'26,Dec'26,Sum",
    '5522104389,9999999,2020-08-21,BO1,CHIPCAP A,0,1358681,2155776,3514457',
    '5522106324,999999,2025-11-21,BO2,CHIPCAP B,41400,178902,177274,397576',
    '5522104424,9999999,2020-09-26,BO3,CHIPCAP C,0,0,0,0',
    '5522106324,999999,2025-11-21,BO4,CHIPCAP D,"1,200",0,0,1200',
    '5522104389,9999999,2020-08-21,BO5,CHIPCAP E,500,0,0,500',
  ].join('\n');

  it('makes a record of each PO with something ordered in the firm month, holding only those rows', async () => {
    const parts = await splitByPoNumber(csv(schedule), 'csv', 'Millenium Schedule Oct26.csv');
    expect(parts?.map((p) => [p.poNumber, p.lines, p.quantityColumn])).toEqual([
      ['5522106324', 2, "Oct'26 Firm Plan"],
      ['5522104389', 1, "Oct'26 Firm Plan"],
    ]);
    const rows = parts![0]!.content.toString().trim().split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^5522106324,999999,2025-11-21,BO2,/);
    expect(rows[2]).toContain('"1,200"');
    expect(parts![1]!.content.toString()).not.toContain('BO1'); // ordered nothing this month
  });

  it('takes the first month when none is marked firm, and splits a schedule even for one PO ordered', async () => {
    const npd = ['BO Code,Description,PO No.,MPN,Oct 26,Nov 26,Dec 26', 'BO9,TVS,5522106414,X,150000,150000,0', 'BO8,CAP,5522104389,Y,0,50000,0'].join('\n');
    const parts = await splitByPoNumber(csv(npd), 'csv', 'NPD.csv');
    expect(parts?.map((p) => [p.poNumber, p.lines, p.quantityColumn])).toEqual([['5522106414', 1, 'Oct 26']]);
  });

  it('notes which month the quantities came from', async () => {
    const [part] = await expandPoFile({ buffer: csv(schedule), originalname: 'S.csv', mimetype: 'text/csv' });
    const { splitNote } = await import('./poSplit.js');
    expect(splitNote(part!.splitFrom!)).toMatch(/^PO 5522106324: 2 line\(s\) ordered under "Oct'26 Firm Plan", one of 2 PO\(s\)/);
  });
});

it('keeps schedule rows ordered with no PO number together as one record, for the reviewer', async () => {
  const sched = ["Purch.Doc.,BO code,Oct'26 Firm Plan,Nov'26", '5522106324,BO2,41400,0', ',BO09606999,24088,0', '5522104424,BO3,0,0'].join('\n');
  const parts = await splitByPoNumber(csv(sched), 'csv', 'S.csv');
  expect(parts?.map((p) => [p.poNumber, p.name, p.lines])).toEqual([
    ['5522106324', 'S - PO 5522106324.csv', 1],
    ['', 'S - no PO number.csv', 1],
  ]);
  const [, noPo] = await expandPoFile({ buffer: csv(sched), originalname: 'S.csv', mimetype: 'text/csv' });
  const { splitNote } = await import('./poSplit.js');
  expect(splitNote(noPo!.splitFrom!)).toMatch(/with no PO number on them/);
});
