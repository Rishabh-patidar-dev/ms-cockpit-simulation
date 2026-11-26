import { HEADER_FIELDS, HEADER_LABELS, LINE_FIELDS, LINE_LABELS } from '../../domain/types.js';

/** Bumped whenever the prompt text changes; stored on every run (FR-4.4). */
export const GENERIC_PROMPT_VERSION = 'generic-v2';

const headerFieldList = HEADER_FIELDS.map((f) => `  - ${f} (${HEADER_LABELS[f]})`).join('\n');
const lineFieldList = LINE_FIELDS.map((f) => `  - ${f} (${LINE_LABELS[f]})`).join('\n');

/**
 * FR-4.3 — the fallback used when no vendor profile matches the document.
 *
 * The confidence instruction is the load-bearing part: a model that reports 0.99 on a
 * value it guessed defeats the entire review screen, so the prompt is explicit that
 * confidence describes legibility and certainty, not plausibility.
 */
export const GENERIC_EXTRACTION_PROMPT = `You are extracting structured data from a customer Purchase Order (PO) document so that a Sales Order can be created in SAP S/4HANA.

Extract the following HEADER fields (one set per document):
${headerFieldList}

Extract the following fields for EACH LINE ITEM on the order:
${lineFieldList}

Rules:
1. Return values exactly as they appear in the document. Do not reformat numbers, dates or codes. If the document says "1.234,56", return "1.234,56".
2. If a field is not present in the document, return null for its value. Never invent, infer or complete a value that is not written on the page.
3. Number every line item sequentially starting at 1, in the order they appear. If the document prints its own line numbers, use those.
4. Include every line item, including ones that continue across a page break. Do not merge or split lines.
5. Ignore totals, subtotals, tax rows, freight rows and notes when building lineItems — those are not ordered materials.
6. Put the order total in the header field poTotalValue, and be careful which total it is. poTotalValue is the value of the goods ordered: the figure that equals the sum of the line item values, BEFORE tax (VAT, TVA, GST, HST, sales tax), freight, handling, fuel and other surcharges. Many documents print several totals — for example "Total HT / TVA / Total TTC", "Subtotal / Freight / Tax / Total due", "Net total / VAT / Gross total". Choose the pre-tax goods total (Total HT, Subtotal, Net total, Basic Total), never the grand total, amount due or gross total. Only when a document prints a single total, and its prices already include tax, use that one as printed. Copy a figure that is printed on the page; do not add up, subtract or calculate a total yourself.
7. Where a line shows a list price, a discount and a net price, unitPrice is the NET price (the one that, multiplied by the quantity, gives the line value) and lineNetValue is the line's extended amount.

Confidence scoring — this is critical:
- Report a confidence between 0.0 and 1.0 for every field, including fields you return as null.
- Confidence must reflect how certain you are that you read the document correctly: character legibility, label ambiguity, and whether the value was clearly labelled.
- Use a LOW confidence (below 0.85) whenever the text was blurred, handwritten, ambiguous, split across lines, or when you had to choose between two candidate values on the page.
- Do not report high confidence because a value looks plausible. A plausible guess must score low. A human reviews every low-confidence field before this reaches SAP, so an honest low score is far more useful than a confident wrong one.
- For a field that is genuinely absent from the document, return value null with a high confidence (you are confident it is not there).

Also report which vendor or customer issued this PO in the "vendorIdentified" field, if their name is visible.`;

/** FR-4.1 — a vendor profile supplies its own prompt; this frames it consistently. */
export function buildVendorPrompt(vendorName: string, vendorPrompt: string): string {
  return `${GENERIC_EXTRACTION_PROMPT}

---
This document is expected to be a Purchase Order from "${vendorName}". The following notes describe that vendor's specific layout. Follow them where they apply, and fall back to the general rules above where they do not:

${vendorPrompt}`;
}

/** Bumped whenever SPREADSHEET_NOTES changes; added to the prompt version of a spreadsheet run. */
export const SPREADSHEET_PROMPT_VERSION = 'sheet-v3';

/**
 * Added to the prompt when the PO is a spreadsheet rather than a PDF. The cells arrive as
 * "Row 7: C7=ESC1010011 | K7=0.3072 | P7=27000", so there is nothing to read unclearly:
 * what can go wrong is choosing the wrong column, and that is what these rules are about.
 */
export const SPREADSHEET_NOTES = `This document is a SPREADSHEET, not a scanned page. It is given row by row, each value as CELL=value (for example "P7=27000"), with every sheet introduced by "### Sheet".

Spreadsheet rules:
- Rows are laid out as a table: find the header row that names the columns (part number, description, quantity, price...), and read each following row as one line item. A label for a header value may sit in the cell to its left or above it.
- Map the columns once and use the same mapping for every row. The customer's own code for the item ("BO code", "Item code", the buyer's part number) is customerMaterialNumber. The supplier's or manufacturer's part number ("MPN", "Mfr part no.", "Supplier part", our material number) is materialCode. Only when the sheet has a single code column is that code materialCode.
- A "Supplying plant", "Vendor", "Supplier" or "MFR"/"Make" column names the supplier or the manufacturer, not the customer's plant: never put it in plant, customerName or customerCode.
- A value may be a calculated result; take it as given. Do not calculate any value yourself.
- Cells marked "(hidden)" were hidden in Excel. They usually hold older orders, past months or helper data. Read labels and titles from them where needed, but take ordered quantities and prices from visible cells unless the visible cells hold nothing for that field.
- The same sheet may show quantities for several POs or months side by side (for example "PO 26-27 220", "PO 26-27 (06.10.2026)", "5-Oct", "Apr FC"). When there is a column for a purchase order, take quantities only from the newest one, never from forecast ("FC") or delivery-month columns, and put that PO's number and date in the header.
- A monthly delivery schedule may have no column for a PO's quantity: each row carries its own PO number (and often an open quantity such as 9999999), and the quantities are by month ("Oct'26 Firm Plan", "Nov 26", ...). Then take each row's quantity from the month marked firm ("Firm", "Firm Plan"), or, if none is marked, from the first month column. A month is not a date: leave deliveryDate null for these lines (never put the column heading, such as "Oct'26 Firm Plan", in a date field), unless the row itself gives a delivery date. Later months are a forecast, not an order. Never use an open quantity like 9999999 or a "Sum" column as the quantity.
- If the rows carry different PO numbers, return the header poNumber as null with a low confidence; the reviewer decides. Do not pick one.
- Words in a PO-number cell ("PO in process", "TBD", "NA", "awaited") mean the PO has not been issued yet: that is not a PO number, so return poNumber null.
- Leave out rows with no ordered quantity (blank or 0) in that column, and rows that are notes, totals or terms. If no row has one, return the rows anyway with null quantities and a low confidence, rather than no line items at all.
- Where a row has an old and a new price ("Price", "New price from ..."), unitPrice is the new one.
- Confidence describes how sure you are that you picked the right cell, since every value is legible. Use a low confidence whenever the column to use was not clearly labelled.`;
