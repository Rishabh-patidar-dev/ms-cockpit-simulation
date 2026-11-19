import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  buildSalesOrderPdf,
  money,
  salesOrderFromRecord,
  salesOrderOptions,
  salesOrderValue,
  type Seller,
} from './salesOrderDocument.js';

const line = (n: number, over: Record<string, unknown> = {}) => ({
  id: `l${n}`, headerId: 'h1', lineNumber: n, materialCode: 'FG111_A', customerMaterialNumber: null,
  description: null, quantity: '100', uom: 'LM', unitPrice: '50,000.00', lineNetValue: '50,000.00',
  deliveryDate: '30.09.2026', plant: '1710', ...over,
});
const header = (lines = [line(1)], over: Record<string, unknown> = {}) => ({
  id: 'h1', recordId: 'r1', poNumber: '6100000029', poDate: '25.09.2026', customerName: 'Shree Demo Industries Pvt Ltd',
  customerCode: '42343', shipTo: 'Plot 14, MIDC Industrial Area, Pune 411019, India', billTo: null,
  requestedDeliveryDate: '30.09.2026', currency: 'INR', paymentTerms: null, incoterms: null, poTotalValue: '50,000.00',
  contact: null, updatedAt: new Date(), lineItems: lines, ...over,
});
const record = (h = header()) => ({ soNumber: '0010002531', statusChangedAt: new Date('2026-11-03T15:43:03Z'), header: h });

/** The PDF's text is uncompressed, so what it says can be read straight out of the bytes. */
const textOf = (pdf: Buffer) => pdf.toString('latin1');
const pdfFor = (h = header(), opts: Parameters<typeof salesOrderFromRecord>[1] = {}) =>
  textOf(buildSalesOrderPdf(salesOrderFromRecord(record(h), opts)));
const pages = (t: string) => t.match(/\/Type \/Page /g)?.length ?? 0;

describe('the Sales Order document, from a record', () => {
  it("carries SAP's number, the PO it came from, the customer and the dates", () => {
    const so = salesOrderFromRecord(record());
    expect(so).toMatchObject({
      soNumber: '0010002531', soDate: '03.11.2026', dueDate: '30.09.2026', poNumber: '6100000029', poDate: '25.09.2026',
      currency: 'INR', total: '50,000.00', totalNumber: 50000,
    });
    expect(so.billTo).toEqual({ name: 'Shree Demo Industries Pvt Ltd', code: '42343', addressLines: ['Plot 14, MIDC Industrial Area, Pune', '411019, India'] });
  });

  it('uses the ship-to for billing when there is no bill-to, and the other way round', () => {
    expect(salesOrderFromRecord(record()).billTo.addressLines.join(' ')).toBe('Plot 14, MIDC Industrial Area, Pune 411019, India');
    const h = header([line(1)], { shipTo: null, billTo: 'Accounts, Pune' });
    const so = salesOrderFromRecord(record(h));
    expect(so.shipTo.addressLines).toEqual(['Accounts, Pune']);
    expect(so.billTo.addressLines).toEqual(['Accounts, Pune']);
  });

  it('numbers the rows in line order', () => {
    const so = salesOrderFromRecord(record(header([line(2, { materialCode: 'B' }), line(1, { materialCode: 'A' })])));
    expect(so.lines.map((l) => [l.item, l.material])).toEqual([['1', 'A'], ['2', 'B']]);
  });

  it('totals the lines when every one reads as a number, and falls back to the PO total when one does not', () => {
    const two = header([line(1, { lineNetValue: '1.234,50' }), line(2, { lineNetValue: '765,50' })]);
    expect(salesOrderFromRecord(record(two)).total).toBe('2,000.00');
    const bad = header([line(1), line(2, { lineNetValue: 'n/a' })], { poTotalValue: '9,999.00' });
    expect(salesOrderFromRecord(record(bad)).total).toBe('9,999.00');
  });

  it('writes a figure as 1,234.56 and leaves one it cannot read exactly as it was', () => {
    expect(money('50000')).toBe('50,000.00');
    expect(money('1.234,56')).toBe('1,234.56');
    expect(money('on request')).toBe('on request');
    expect(money(null)).toBe('');
  });
});

describe('the demo price factor', () => {
  const lower = (f: number, h = header()) => salesOrderFromRecord(record(h), { priceFactor: f });

  it("keeps the PO's own prices at 1, with no discount and no note", () => {
    const so = lower(1);
    expect([so.lines[0]!.listPrice, so.lines[0]!.discount, so.lines[0]!.amount, so.total]).toEqual(['50,000.00', '0.00 (%)', '50,000.00', '50,000.00']);
    expect(so.priceNote).toBe('');
  });

  it('shows the PO price as the list price and takes 40% off it at 0.6, leaving the quantity alone', () => {
    const so = lower(0.6, header([line(1), line(2, { quantity: '40', unitPrice: '500', lineNetValue: '20,000.00' })]));
    expect(so.lines.map((l) => [l.qty, l.listPrice, l.discount, l.amount])).toEqual([
      ['100', '50,000.00', '40.00 (%)', '30,000.00'],
      ['40', '500.00', '40.00 (%)', '12,000.00'],
    ]);
    expect(so.total).toBe('42,000.00');
    expect(so.totalNumber).toBe(42000);
  });

  it('rounds to the cent', () => {
    expect(lower(0.6, header([line(1, { lineNetValue: '10.05' })])).lines[0]!.amount).toBe('6.03');
  });

  it('scales the PO total when the lines cannot be added, and leaves a figure it cannot read as it was', () => {
    const bad = header([line(1, { lineNetValue: 'n/a', unitPrice: 'on request' })], { poTotalValue: '1,000.00' });
    const so = lower(0.6, bad);
    expect(so.total).toBe('600.00');
    expect(so.lines[0]!.listPrice).toBe('on request');
  });

  it("says that the discount is a demo setting, not SAP's", () => {
    expect(lower(0.6).priceNote).toBe("Demo pricing: a 40% discount is applied to the customer's purchase order prices.");
  });
});

describe('the Sales Order value on the worklist', () => {
  it('is the figure the document totals to, with its currency', () => {
    const h = header([line(1), line(2, { lineNetValue: '20,000.00' })]);
    expect(salesOrderValue(h)).toEqual({ value: '70,000.00', currency: 'INR' });
    expect(salesOrderValue(h, 0.6)).toEqual({ value: '42,000.00', currency: 'INR' });
    expect(salesOrderValue(h, 0.6)!.value).toBe(salesOrderFromRecord(record(h), { priceFactor: 0.6 }).total);
  });

  it('falls back to the PO total when a line cannot be read, and to nothing when there is no figure', () => {
    const bad = header([line(1, { lineNetValue: 'n/a' })], { poTotalValue: '1,000.00' });
    expect(salesOrderValue(bad, 0.6)).toEqual({ value: '600.00', currency: 'INR' });
    expect(salesOrderValue(header([line(1, { lineNetValue: null })], { poTotalValue: null }))).toBeNull();
    expect(salesOrderValue(null)).toBeNull();
  });
});

describe('the amount in words', () => {
  it('writes rupees in the Indian system, with paise', () => {
    expect(amountInWords(30000, 'INR')).toBe('Rs. Thirty Thousand Only');
    expect(amountInWords(11101.48, 'INR')).toBe('Rs. Eleven Thousand One Hundred One and Forty-Eight Paise Only');
    expect(amountInWords(100000, 'INR')).toBe('Rs. One Lakh Only');
    expect(amountInWords(12345678, 'INR')).toBe('Rs. One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight Only');
    expect(amountInWords(0, 'INR')).toBe('Rs. Zero Only');
  });

  it('gives another currency its code and the cents as a fraction', () => {
    expect(amountInWords(1250.5, 'EUR')).toBe('EUR One Thousand Two Hundred Fifty and 50/100 Only');
  });
});

describe('the seller details', () => {
  it('splits the lists on "|" and drops what is empty', () => {
    const o = salesOrderOptions({
      SELLER_NAME: ' ', SELLER_ADDRESS: 'Plot 1 | Pune ||', SELLER_CONTACT: '', SELLER_TAX_IDS: 'GSTIN - X', SO_TERMS: 'One|Two', SO_DOC_PRICE_FACTOR: 0.6,
    });
    expect(o).toEqual({
      priceFactor: 0.6,
      seller: { name: 'Millennium Semiconductors', addressLines: ['Plot 1', 'Pune'], contact: '', taxIds: 'GSTIN - X', terms: ['One', 'Two'] },
    });
  });
});

describe('the Sales Order PDF', () => {
  it('is an order form that says what the order is', () => {
    const t = pdfFor();
    expect(t.startsWith('%PDF-1.4')).toBe(true);
    expect(t.trimEnd().endsWith('%%EOF')).toBe(true);
    for (const s of [
      'SALES ORDER', 'Millennium Semiconductors', '0010002531', '6100000029', 'Billing Details', 'Shipping Details',
      'Shree Demo Industries Pvt Ltd', 'List Price', 'FG111_A', 'Rs. Fifty Thousand Only',
    ]) {
      expect(t).toContain(s);
    }
  });

  it('shows the Sales Order value in the details as well as the total', () => {
    const t = pdfFor();
    expect(t).toContain('(SO Value) Tj');
    expect(t).toContain('(: INR 50,000.00) Tj');
    expect(t).toContain('(Total) Tj');
  });

  it('closes with the wording for the number: unique, and created from the system', () => {
    // The notes wrap over lines, so read the text as one run.
    const run = [...pdfFor().matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).join(' ');
    expect(run).toContain('Please quote Sales Order 0010002531 on all correspondence and delivery queries.');
    expect(run).toContain('Prepared from the approved purchase order. The Sales Order number is unique and is created from the system.');
    expect(run).not.toContain('issued by SAP');
  });

  it('leaves out the company details, tax numbers and terms that are not set, and never prints a tax column', () => {
    const t = pdfFor();
    for (const s of ['GSTIN', 'Terms and Conditions', 'HSN', 'Tax %']) expect(t).not.toContain(s);
  });

  it('prints them when they are set', () => {
    const seller: Seller = {
      name: 'Millennium Semiconductors', addressLines: ['Plot 1, Pune'], contact: 'orders@example.test', taxIds: 'GSTIN - 27AAAAA0000A1Z5',
      terms: ['Goods once sold will not be taken back.'],
    };
    const t = pdfFor(header(), { seller });
    for (const s of ['Plot 1, Pune', 'orders@example.test', 'GSTIN - 27AAAAA0000A1Z5', 'Terms and Conditions', '1. Goods once sold will not be taken back.']) {
      expect(t).toContain(s);
    }
  });

  it('prints the terms when the PO has them', () => {
    const t = pdfFor(header([line(1)], { paymentTerms: 'Net 30', incoterms: 'DAP Pune' }));
    expect(t).toContain('Net 30');
    expect(t).toContain('DAP Pune');
  });

  it('shows the discount and the demo-pricing note when the factor is below 1', () => {
    const t = pdfFor(header(), { priceFactor: 0.6 });
    expect(t).toContain('(40.00 \\(%\\)) Tj');
    expect(t).toContain('Demo pricing: a 40% discount is applied');
    expect(t).toContain('Rs. Thirty Thousand Only');
    expect(pdfFor()).not.toContain('Demo pricing');
  });

  it('runs onto more pages when there are many lines, repeating the column headings on each', () => {
    const many = Array.from({ length: 60 }, (_, i) => line(i + 1));
    const t = pdfFor(header(many));
    expect(pages(t)).toBeGreaterThan(1);
    expect(t.match(/\(List Price\) Tj/g)?.length).toBe(pages(t));
    expect(t.match(/\(Total\) Tj/g)?.length).toBe(1);
  });

  it('never leaves the totals alone on a page of their own when the lines only just fill one', () => {
    for (let n = 1; n <= 40; n++) {
      const t = pdfFor(header(Array.from({ length: n }, (_, i) => line(i + 1))));
      const last = t.split('/Type /Page ').pop()!;
      expect(last).toContain('(List Price) Tj');
    }
  });

  it('keeps the file sound when a name has accents or characters outside Latin-1', () => {
    const t = pdfFor(header([line(1)], { customerName: 'Établissements Lemaire 株式会社 (Ltd)' }));
    expect(t).toContain('\\(Ltd\\)');
    expect(t).toContain('?'); // the characters WinAnsi cannot hold
    // Every stream's declared length matches its bytes, so a viewer does not reject the file.
    for (const m of t.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      expect(Buffer.byteLength(m[2]!, 'latin1')).toBe(Number(m[1]));
    }
    // And the cross-reference table points at the objects it says it does.
    const startxref = Number(/startxref\n(\d+)/.exec(t)![1]);
    expect(t.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...t.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(t.slice(off, off + 7)).toBe(`${i + 1} 0 obj`));
  });
});
