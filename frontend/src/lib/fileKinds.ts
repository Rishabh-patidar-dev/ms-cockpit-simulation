/**
 * What may be uploaded as a PO: a PDF, an Excel workbook (.xlsx), a CSV, or an Outlook email (.msg) carrying one. The server
 * decides by the file's bytes; this only turns away, before sending, a file that
 * positively claims to be something else. Some sources drop files with an empty MIME
 * type, so those are left for the server to judge.
 */

export const SPREADSHEET_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'text/csv',
];

const ACCEPTED_TYPES = new Set(['application/pdf', 'application/vnd.ms-outlook', ...SPREADSHEET_MIME_TYPES]);
const ACCEPTED_NAME = /\.(pdf|xlsx|xlsm|csv|msg)$/i;

/** For the file picker's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = ['.pdf', '.xlsx', '.xlsm', '.csv', '.msg', ...ACCEPTED_TYPES].join(',');

/**
 * An Outlook email saved as .msg. The server opens it and makes a record of each PO attached
 * (a PDF or a spreadsheet), so one file can give several records.
 */
export const isOutlookEmail = (file: { name: string }) => /\.msg$/i.test(file.name);

/** Null when the file may be sent, otherwise why not. */
export function refusalFor(file: { name: string; type: string }): string | null {
  if (/\.xls$/i.test(file.name)) return `${file.name} is an Excel 97–2003 workbook. Save it as .xlsx and upload that.`;
  // Windows reports CSV files as application/vnd.ms-excel; the name settles those.
  if (!file.type || ACCEPTED_TYPES.has(file.type) || ACCEPTED_NAME.test(file.name)) return null;
  return `${file.name} is not a PDF, an Excel workbook (.xlsx), a CSV file or an Outlook email (.msg).`;
}

/** Whether a stored document is a spreadsheet, from the MIME type the server recorded. */
export const isSpreadsheetType = (mimeType: string | null | undefined) =>
  !!mimeType && SPREADSHEET_MIME_TYPES.includes(mimeType);
