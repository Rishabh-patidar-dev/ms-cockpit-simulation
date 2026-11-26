import { looksLikeOle, readMsg } from './msg.js';
import { readXlsx, sheetsToText } from './xlsx.js';
import { looksLikeZip, readZip } from './zip.js';

/**
 * The kinds of document a PO can arrive as. A PDF goes to the extractor as it is; a
 * spreadsheet or an email is turned into text (and an email's attachments into parts of
 * their own), because the model reads PDFs, images and text but not Excel or Outlook files.
 */
export type DocumentKind = 'pdf' | 'xlsx' | 'csv' | 'msg' | 'image';

export interface DetectedDocument {
  kind: DocumentKind;
  mimeType: string;
  /** The extension the stored copy gets. */
  ext: string;
}

export const ACCEPTED_DESCRIPTION = 'PDF, Excel (.xlsx), CSV, Outlook email (.msg), PNG or JPEG';

const extOf = (filename: string) => filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

function isMostlyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;
  const text = sample.toString('utf8');
  const bad = (text.match(/�/g) ?? []).length;
  return bad < 4;
}

/**
 * FR-1.2 / NFR-3.4 — decided by content, not by the name. The name only settles what the
 * bytes cannot: whether text is a CSV. Returns a reason when the file is refused.
 */
export function detectDocument(buffer: Buffer, filename: string): DetectedDocument | { error: string } {
  const ext = extOf(filename);
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mimeType: 'application/pdf', ext: 'pdf' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', mimeType: 'image/png', ext: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: 'image', mimeType: 'image/jpeg', ext: 'jpg' };
  if (looksLikeZip(buffer)) {
    try {
      const files = readZip(buffer);
      if (files.has('xl/workbook.xml')) {
        return { kind: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
      }
      if (files.has('word/document.xml')) return { error: 'Word documents are not accepted. Save it as a PDF and upload that.' };
    } catch (err) {
      return { error: `The file could not be opened: ${(err as Error).message}` };
    }
    return { error: `This zip file is not an Excel workbook. Accepted: ${ACCEPTED_DESCRIPTION}.` };
  }
  if (looksLikeOle(buffer)) {
    try {
      readMsg(buffer);
      return { kind: 'msg', mimeType: 'application/vnd.ms-outlook', ext: 'msg' };
    } catch {
      return {
        error:
          ext === 'xls'
            ? 'Old-style Excel (.xls) files are not accepted. Open it in Excel, save it as .xlsx, and upload that.'
            : `This Office file is not an Outlook email. Accepted: ${ACCEPTED_DESCRIPTION}.`,
      };
    }
  }
  if ((ext === 'csv' || ext === 'tsv' || ext === 'txt') && isMostlyText(buffer)) {
    return { kind: 'csv', mimeType: 'text/csv', ext: 'csv' };
  }
  return { error: `This file type is not accepted. Accepted: ${ACCEPTED_DESCRIPTION}.` };
}

export type ExtractionPart = { inlineData: { mimeType: string; data: string } } | { text: string };

const textPart = (text: string): ExtractionPart => ({ text });
const filePart = (mimeType: string, buffer: Buffer): ExtractionPart => ({
  inlineData: { mimeType, data: buffer.toString('base64') },
});

/** Pictures in an email under this size are signatures and logos, not POs. */
const MIN_ATTACHED_IMAGE_BYTES = 30 * 1024;

const spreadsheetText = (filename: string, buffer: Buffer, kind: 'xlsx' | 'csv') =>
  kind === 'xlsx'
    ? `Spreadsheet "${filename}". Each line is one spreadsheet row: "R<row number>: cell | cell | …" (empty cells kept as blanks so columns line up). Numbers are as Excel stores them; a date may appear as an Excel serial number (days since 1899-12-30).\n\n${sheetsToText(readXlsx(buffer))}`
    : `CSV file "${filename}":\n\n${buffer.toString('utf8').replace(/^﻿/, '')}`;

function mailHeaderText(filename: string, mail: ReturnType<typeof readMsg>): string {
  return [
    `Email "${filename}".`,
    mail.subject && `Subject: ${mail.subject}`,
    mail.from && `From: ${mail.from}`,
    mail.to && `To: ${mail.to}`,
    mail.cc && `Cc: ${mail.cc}`,
    mail.sentAt && `Sent: ${mail.sentAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    mail.attachments.length
      ? `Attachments: ${mail.attachments.map((a) => a.name).join(', ')}`
      : 'Attachments: none',
    '',
    'Body:',
    mail.body ?? '(no text body)',
  ]
    .filter((l): l is string => typeof l === 'string')
    .join('\n');
}

/**
 * What the extractor is given for one document, in order. An email becomes its header and
 * body as text, then each attachment it can read; an attachment it cannot read is named
 * so the model (and the reviewer) knows something was left out.
 */
export function extractionParts(buffer: Buffer, filename: string, depth = 0): ExtractionPart[] {
  const detected = detectDocument(buffer, filename);
  if ('error' in detected) return [textPart(`[Attachment "${filename}" was not read: ${detected.error}]`)];

  switch (detected.kind) {
    case 'pdf':
    case 'image':
      return [filePart(detected.mimeType, buffer)];
    case 'xlsx':
    case 'csv':
      return [textPart(spreadsheetText(filename, buffer, detected.kind))];
    case 'msg': {
      const mail = readMsg(buffer);
      const parts: ExtractionPart[] = [textPart(mailHeaderText(filename, mail))];
      for (const a of mail.attachments) {
        const kind = detectDocument(a.content, a.name);
        if (!('error' in kind) && kind.kind === 'image' && a.content.length < MIN_ATTACHED_IMAGE_BYTES) continue;
        if (!('error' in kind) && kind.kind === 'msg' && depth >= 2) continue;
        parts.push(textPart(`--- Attachment "${a.name}" ---`));
        parts.push(...extractionParts(a.content, a.name, depth + 1));
      }
      for (const name of mail.skippedAttachments) parts.push(textPart(`[Attachment "${name}" could not be opened and was not read.]`));
      return parts;
    }
  }
}

export interface DocumentPreview {
  kind: DocumentKind;
  /** A readable rendering of the document, for the review screen. Empty for a PDF or image. */
  text: string;
}

/** The review screen's view of a document that a browser cannot show by itself. */
export function documentPreview(buffer: Buffer, filename: string): DocumentPreview {
  const detected = detectDocument(buffer, filename);
  if ('error' in detected) return { kind: 'pdf', text: '' };
  const parts = extractionParts(buffer, filename);
  const text = parts
    .map((p) => ('text' in p ? p.text : `[${p.inlineData.mimeType === 'application/pdf' ? 'PDF' : 'Image'} attachment — download the original to view it]`))
    .join('\n\n');
  return { kind: detected.kind, text: detected.kind === 'pdf' || detected.kind === 'image' ? '' : text };
}
