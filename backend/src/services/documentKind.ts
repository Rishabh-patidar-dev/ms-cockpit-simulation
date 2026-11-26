/**
 * Which kinds of file a PO may arrive as, recognised by content, not by name (NFR-3.4).
 *
 * A PDF and an Excel workbook carry a signature in their first bytes. A CSV has none, so
 * it is the one kind that also needs its name: a ".csv" file whose bytes are plain text.
 */

export type DocumentKind = 'pdf' | 'xlsx' | 'csv';

export const MIME_TYPES: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/** The file name the stored copy gets on disk. */
export const STORED_NAMES: Record<DocumentKind, string> = {
  pdf: 'original.pdf',
  xlsx: 'original.xlsx',
  csv: 'original.csv',
};

export const isSpreadsheet = (kind: DocumentKind | null): kind is 'xlsx' | 'csv' => kind === 'xlsx' || kind === 'csv';

/** The kind a stored document was saved as, from its MIME type. Unknown types read as PDF, as every older record is. */
export function kindOfMimeType(mimeType: string | null | undefined): DocumentKind {
  const found = (Object.keys(MIME_TYPES) as DocumentKind[]).find((k) => MIME_TYPES[k] === mimeType);
  return found ?? 'pdf';
}

const startsWith = (buffer: Buffer, bytes: number[]) => bytes.every((b, i) => buffer[i] === b);

/** An OLE2 container: an Excel 97–2003 .xls (or a .doc), which is not read here. */
export function looksLikeLegacyExcel(buffer: Buffer): boolean {
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

/**
 * An .xlsx is a zip whose entries include xl/workbook.xml. Zip entry names are stored
 * uncompressed, so they can be found in the bytes without unpacking anything. A .docx
 * or any other zip has no such entry and is refused.
 */
export function looksLikeXlsx(buffer: Buffer): boolean {
  if (!startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return false;
  return buffer.includes('xl/workbook.xml', 0, 'latin1');
}

/** Plain text: no NUL bytes, and valid UTF-8 (a byte-order mark is allowed). */
export function looksLikeText(buffer: Buffer): boolean {
  if (buffer.byteLength === 0 || buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    // Excel on Windows often saves CSV as Windows-1252. That is text too; it is decoded as such later.
    return !/[\x00-\x08\x0e-\x1f]/.test(buffer.toString('latin1'));
  }
}

export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** What this file is, or null when it is none of the kinds accepted. */
export function detectDocumentKind(buffer: Buffer, filename: string): DocumentKind | null {
  if (looksLikePdf(buffer)) return 'pdf';
  if (looksLikeXlsx(buffer)) return 'xlsx';
  if (/\.csv$/i.test(filename.trim()) && looksLikeText(buffer)) return 'csv';
  return null;
}

/** The reason a file was refused, in words for the person who sent it. */
export function unsupportedReason(buffer: Buffer, filename: string): string {
  if (looksLikeLegacyExcel(buffer)) {
    return `${filename} is an Excel 97–2003 workbook (.xls). Open it in Excel and save it as .xlsx, then upload that.`;
  }
  if (/\.xlsx$/i.test(filename) || /\.xlsm$/i.test(filename)) {
    return `${filename} is named like an Excel workbook but is not a readable .xlsx file.`;
  }
  return `${filename} is not a PDF, an Excel workbook (.xlsx) or a CSV file.`;
}

/** File names an attachment or upload could be, used to pick candidates before reading their bytes. */
export const ACCEPTED_NAME = /\.(pdf|xlsx|xlsm|csv)$/i;
