import type { POHeader, POLineItem } from '@prisma/client';
import { parseDecimal } from '../domain/validation.js';
import { PAGE, TextPdf, textWidth } from '../lib/textPdf.js';

/**
 * The Sales Order document: what the order became once SAP created it, laid out as a
 * bordered order form (title bar, company block, order details, billing and shipping,
 * items, total, amount in words, notes and signature). It is built on demand from the
 * approved purchase order and the Sales Order number SAP answered with, so it can never
 * disagree with what the Business Command Centre holds, and nothing extra is stored.
 *
 * Only what the Business Command Centre actually knows is printed. The company's address, contact, tax
 * numbers and terms come from settings and are left out when they are not set, and there
 * is no tax or HSN column because none of it is on the record.
 */
export const SELLER_NAME = 'Millennium Semiconductors';

export interface Seller {
  name: string;
  addressLines: string[];
  contact: string;
  taxIds: string;
  terms: string[];
}

export interface Party {
  name: string;
  code: string;
  addressLines: string[];
}

export interface SalesOrderLine {
  item: string;
  material: string;
  description: string;
  qty: string;
  uom: string;
  /** The PO's own price. */
  listPrice: string;
  /** The discount taken off the list price, as printed, e.g. "40.00 (%)". */
  discount: string;
  amount: string;
  plant: string;
  delivery: string;
}

export interface SalesOrderDoc {
  soNumber: string;
  soDate: string;
  dueDate: string;
  poNumber: string;
  poDate: string;
  currency: string;
  paymentTerms: string;
  incoterms: string;
  billTo: Party;
  shipTo: Party;
  lines: SalesOrderLine[];
  total: string;
  /** The total as a number, for the amount in words; null when it cannot be worked out. */
  totalNumber: number | null;
  /** Printed under the order when the prices are not the PO's own; empty when they are. */
  priceNote: string;
  seller: Seller;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (d: Date) => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A figure as 1,234.56 when it reads as a number, otherwise exactly as it was read. */
export function money(raw: string | null | undefined): string {
  const n = parseDecimal(raw);
  if (n == null) return (raw ?? '').trim();
  return fmt(n);
}

/** The same figure at `factor` of its size, to the cent; as it was read when it is not a number. */
function scaled(raw: string | null | undefined, factor: number): string {
  const n = parseDecimal(raw);
  if (n == null || factor === 1) return money(raw);
  return fmt(Math.round(n * factor * 100) / 100);
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > max) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

/** A whole number in words, in the Indian system: thousand, lakh, crore. */
function wholeInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const hundred = Math.floor((n % 1e3) / 100);
  const rest = n % 100;
  if (crore) parts.push(`${wholeInWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(below100(rest));
  return parts.join(' ');
}

/**
 * "Rs. Eleven Thousand One Hundred One and Forty-Eight Paise Only". Rupees get Rs. and paise;
 * any other currency gets its code and the cents as a fraction of a hundred.
 */
export function amountInWords(amount: number, currency: string): string {
  const cents = Math.round(amount * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  const inr = currency.toUpperCase() === 'INR';
  const head = inr ? 'Rs.' : currency.toUpperCase();
  const tail = frac === 0 ? '' : inr ? ` and ${below100(frac)} Paise` : ` and ${pad(frac)}/100`;
  return `${head} ${wholeInWords(whole)}${tail} Only`;
}

/** Seller details and the price setting, from the app's settings (empty strings leave a line out). */
export function salesOrderOptions(env: {
  SELLER_NAME: string;
  SELLER_ADDRESS: string;
  SELLER_CONTACT: string;
  SELLER_TAX_IDS: string;
  SO_TERMS: string;
  SO_DOC_PRICE_FACTOR: number;
}): { priceFactor: number; seller: Seller } {
  const list = (s: string) => s.split('|').map((x) => x.trim()).filter(Boolean);
  return {
    priceFactor: env.SO_DOC_PRICE_FACTOR,
    seller: {
      name: env.SELLER_NAME.trim() || SELLER_NAME,
      addressLines: list(env.SELLER_ADDRESS),
      contact: env.SELLER_CONTACT.trim(),
      taxIds: env.SELLER_TAX_IDS.trim(),
      terms: list(env.SO_TERMS),
    },
  };
}

/** The total is the sum of the lines when every one reads as a number; otherwise the PO's own total. */
function orderTotal(lineItems: { lineNetValue: string | null }[], poTotalValue: string | null | undefined, priceFactor: number): number | null {
  const values = lineItems.map((l) => parseDecimal(l.lineNetValue));
  const allNumbers = values.length > 0 && values.every((v) => v != null);
  const base = allNumbers ? values.reduce((a, b) => a! + b!, 0)! : parseDecimal(poTotalValue);
  return base == null ? null : Math.round(base * priceFactor * 100) / 100;
}

/** What the Sales Order is worth, as the document prints it (the worklist shows the same figure). */
export function salesOrderValue(
  header: { lineItems: { lineNetValue: string | null }[]; poTotalValue: string | null; currency: string | null } | null,
  priceFactor = 1,
): { value: string; currency: string } | null {
  if (!header) return null;
  const n = orderTotal(header.lineItems, header.poTotalValue, priceFactor);
  const value = n == null ? money(header.poTotalValue) : fmt(n);
  return value ? { value, currency: header.currency ?? '' } : null;
}

/**
 * SAP's answer carries only the order number, so the Business Command Centre has no SAP prices to print and
 * uses the PO's. `priceFactor` is a demo setting for showing SAP pricing the order differently:
 * 0.6 takes 40% off every list price and says so on the document. Quantities never change.
 */
export function salesOrderFromRecord(
  record: {
    soNumber: string | null;
    statusChangedAt: Date;
    header: (POHeader & { lineItems: POLineItem[] }) | null;
  },
  { priceFactor = 1, seller = { name: SELLER_NAME, addressLines: [], contact: '', taxIds: '', terms: [] } }: { priceFactor?: number; seller?: Seller } = {},
): SalesOrderDoc {
  const h = record.header;
  const discountPct = Math.round((1 - priceFactor) * 1000) / 10;
  const lines: SalesOrderLine[] = [...(h?.lineItems ?? [])]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((l) => ({
      item: String(l.lineNumber),
      material: l.materialCode ?? l.customerMaterialNumber ?? '',
      description: l.description ?? '',
      qty: (l.quantity ?? '').trim(),
      uom: l.uom ?? '',
      listPrice: money(l.unitPrice),
      discount: `${discountPct.toFixed(2)} (%)`,
      amount: scaled(l.lineNetValue, priceFactor),
      plant: l.plant ?? '',
      delivery: l.deliveryDate ?? '',
    }));

  const totalNumber = orderTotal(h?.lineItems ?? [], h?.poTotalValue, priceFactor);

  const party = (text: string | null | undefined): Party => ({
    name: h?.customerName ?? '',
    code: h?.customerCode ?? '',
    addressLines: wrap(text ?? '', 40),
  });

  return {
    soNumber: record.soNumber ?? '',
    soDate: dateOf(record.statusChangedAt),
    dueDate: h?.requestedDeliveryDate ?? lines.find((l) => l.delivery)?.delivery ?? '',
    poNumber: h?.poNumber ?? '',
    poDate: h?.poDate ?? '',
    currency: h?.currency ?? '',
    paymentTerms: h?.paymentTerms ?? '',
    incoterms: h?.incoterms ?? '',
    billTo: party(h?.billTo ?? h?.shipTo),
    shipTo: party(h?.shipTo ?? h?.billTo),
    lines,
    total: totalNumber == null ? money(h?.poTotalValue) : fmt(totalNumber),
    totalNumber,
    priceNote:
      priceFactor === 1 ? '' : `Demo pricing: a ${discountPct}% discount is applied to the customer's purchase order prices.`,
    seller,
  };
}

/** Cut a cell to its column rather than let it run into the next one. */
const clip = (s: string, size: number, width: number, bold = false) => {
  let out = s;
  while (out.length > 1 && textWidth(out, size, bold) > width) out = out.slice(0, -1);
  return out;
};

const L = 40;
const R = PAGE.width - 40;
const W = R - L;
const PEACH = '#fbd5b3';
const PEACH_DARK = '#f9c49b';
const GREY = '#e4e4e4';
const GREEN = '#dfe8c6';
/** Column edges of the items table, left to right. */
const EDGES = [40, 68, 206, 242, 296, 334, 368, 430, 486, 555];
const ROW = 26;
const HEAD = 22;
const MIN_ROWS = 5;

export function buildSalesOrderPdf(so: SalesOrderDoc): Buffer {
  const pdf = new TextPdf();
  const mid = (a: number, b: number) => (a + b) / 2;

  // ---- title bar and company block
  pdf.box(L, 40, W, 24, { fill: GREY });
  pdf.text('SALES ORDER', mid(L, R), 57, { size: 13, bold: true, align: 'center' });

  const sellerLines = [...so.seller.addressLines, so.seller.contact, so.seller.taxIds].filter(Boolean);
  const sellerH = 38 + sellerLines.length * 12;
  pdf.box(L, 64, W, sellerH);
  pdf.text(so.seller.name, mid(L, R), 86, { size: 15, bold: true, align: 'center' });
  sellerLines.forEach((s, i) => pdf.text(s, mid(L, R), 102 + i * 12, { size: 9, align: 'center' }));
  let top = 64 + sellerH;

  // ---- order details
  const left: [string, string, boolean?][] = [
    ['Sale Order Number', so.soNumber],
    ['Sale Order Date', so.soDate],
    ['Order Due Date', so.dueDate],
    ['SO Value', `${so.currency} ${so.total}`.trim(), true],
  ];
  const right = (
    [
      ['Customer PO No.', so.poNumber],
      ['Customer PO Date', so.poDate],
      ['Account No.', so.billTo.code],
      ['Currency', so.currency],
      ['Payment Terms', so.paymentTerms],
      ['Incoterms', so.incoterms],
    ] as [string, string][]
  ).filter(([, v]) => v.trim() !== '');
  const detailRows = Math.max(left.length, right.length);
  const detailH = 14 + detailRows * 15;
  pdf.box(L, top, W, detailH);
  left.forEach(([k, v, bold], i) => {
    pdf.text(k, L + 8, top + 18 + i * 15, { size: 9.5, bold: true });
    pdf.text(`: ${v}`, L + 108, top + 18 + i * 15, { size: 9.5, bold: bold === true });
  });
  right.forEach(([k, v], i) => {
    pdf.text(k, 300, top + 18 + i * 15, { size: 9.5, bold: true });
    pdf.text(`: ${v}`, 392, top + 18 + i * 15, { size: 9.5 });
  });
  top += detailH;

  // ---- billing and shipping
  const half = W / 2;
  const partyH = 98;
  ([['Billing Details', so.billTo, L], ['Shipping Details', so.shipTo, L + half]] as [string, Party, number][]).forEach(
    ([title, p, x]) => {
      pdf.box(x, top, half, partyH);
      pdf.text(title, x + 8, top + 17, { size: 10.5, bold: true });
      pdf.text(clip(p.name, 10, half - 16, true), x + 8, top + 34, { size: 10, bold: true });
      if (p.code) pdf.text(`Account No.: ${p.code}`, x + 8, top + 48, { size: 9 });
      if (p.addressLines.length > 0) {
        pdf.text('Address:', x + 8, top + 63, { size: 9, bold: true });
        p.addressLines.slice(0, 3).forEach((l, i) => pdf.text(l, x + 54, top + 63 + i * 11, { size: 9 }));
      }
    },
  );
  top += partyH;

  // ---- items, over as many pages as they need
  const heading = (t: number) => {
    pdf.box(L, t, W, HEAD, { fill: PEACH });
    const labels = ['Sr.', 'Item Description', 'Plant', 'Delivery', 'Qty', 'Unit', 'List Price', 'Disc.', `Amount (${so.currency || '-'})`];
    labels.forEach((lab, i) => pdf.text(lab, mid(EDGES[i]!, EDGES[i + 1]!), t + 15, { size: 9, bold: true, align: 'center' }));
    EDGES.slice(1, -1).forEach((x) => pdf.line(x, t, x, t + HEAD));
  };
  const rowsAt = (t: number, rows: SalesOrderLine[]) => {
    rows.forEach((l, i) => {
      const y = t + HEAD + i * ROW;
      const c = (n: number) => mid(EDGES[n]!, EDGES[n + 1]!);
      pdf.text(l.item, c(0), y + 17, { size: 9, align: 'center' });
      pdf.text(clip(l.material, 9.5, EDGES[2]! - EDGES[1]! - 12, true), EDGES[1]! + 6, y + 12, { size: 9.5, bold: true });
      if (l.description) pdf.text(clip(l.description, 8, EDGES[2]! - EDGES[1]! - 12), EDGES[1]! + 6, y + 22, { size: 8 });
      pdf.text(l.plant, c(2), y + 17, { size: 9, align: 'center' });
      pdf.text(clip(l.delivery, 8.5, EDGES[4]! - EDGES[3]! - 4), c(3), y + 17, { size: 8.5, align: 'center' });
      pdf.text(l.qty, EDGES[5]! - 6, y + 17, { size: 9, align: 'right' });
      pdf.text(l.uom, c(5), y + 17, { size: 9, align: 'center' });
      pdf.text(l.listPrice, EDGES[7]! - 6, y + 17, { size: 9, align: 'right' });
      pdf.text(l.discount, c(7), y + 17, { size: 9, align: 'center' });
      pdf.text(l.amount, EDGES[9]! - 6, y + 17, { size: 9, align: 'right' });
    });
  };
  const body = (t: number, count: number) => {
    const h = count * ROW;
    pdf.box(L, t + HEAD, W, h);
    EDGES.slice(1, -1).forEach((x) => pdf.line(x, t + HEAD, x, t + HEAD + h));
    return t + HEAD + h;
  };

  let remaining = [...so.lines];
  let tableTop = top;
  for (;;) {
    const capFull = Math.floor((770 - tableTop - HEAD) / ROW);
    const capLast = Math.floor((590 - tableTop - HEAD) / ROW);
    const take = remaining.length <= capLast ? remaining.length : remaining.length <= capFull ? remaining.length - 1 : capFull;
    const last = take === remaining.length;
    heading(tableTop);
    rowsAt(tableTop, remaining.slice(0, take));
    const bottom = body(tableTop, last ? Math.max(take, MIN_ROWS) : take);
    remaining = remaining.slice(take);
    if (last) {
      top = bottom;
      break;
    }
    pdf.newPage();
    tableTop = 60;
  }

  // ---- total, amount in words, pricing note
  pdf.box(L, top, W, 24, { fill: PEACH_DARK });
  pdf.text('Total', mid(EDGES[1]!, EDGES[2]!), top + 17, { size: 12, bold: true, align: 'center' });
  pdf.text(so.total, EDGES[9]! - 6, top + 17, { size: 12, bold: true, align: 'right' });
  top += 24;
  pdf.box(L, top, W, 22);
  pdf.text(so.totalNumber == null ? '' : amountInWords(so.totalNumber, so.currency || ''), L + 6, top + 15, { size: 9.5, bold: true });
  top += 22;
  if (so.priceNote) {
    pdf.box(L, top, W, 20, { fill: GREEN });
    pdf.text(so.priceNote, L + 6, top + 14, { size: 9, bold: true });
    top += 20;
  }

  // ---- notes and terms, and the signature box
  const notes = [
    ...wrap(`Please quote Sales Order ${so.soNumber} on all correspondence and delivery queries.`, 66),
    ...wrap('Prepared from the approved purchase order. The Sales Order number is unique and is created from the system.', 66),
  ];
  const terms = so.seller.terms.flatMap((t, i) => wrap(`${i + 1}. ${t}`, 62));
  const notesH = Math.max(110, 30 + notes.length * 12 + (terms.length ? 26 + terms.length * 12 : 0) + 8);
  const noteW = 320;
  pdf.box(L, top, noteW, notesH);
  pdf.text('Notes', L + 8, top + 17, { size: 10.5, bold: true });
  notes.forEach((n, i) => pdf.text(n, L + 8, top + 32 + i * 12, { size: 9 }));
  if (terms.length) {
    const ty = top + 32 + notes.length * 12 + 12;
    pdf.text('Terms and Conditions', L + 8, ty, { size: 10.5, bold: true });
    terms.forEach((t, i) => pdf.text(t, L + 8, ty + 15 + i * 12, { size: 9 }));
  }
  pdf.box(L + noteW, top, W - noteW, notesH);
  pdf.text(`For ${so.seller.name}`, mid(L + noteW, R), top + 18, { size: 10.5, bold: true, align: 'center' });
  pdf.text('Signature', R - 8, top + notesH - 10, { size: 10.5, bold: true, align: 'right' });

  return pdf.build();
}
