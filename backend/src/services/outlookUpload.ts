import { detectDocumentKind, looksLikeLegacyExcel, MIME_TYPES, type DocumentKind } from './documentKind.js';
import { looksLikeOle, readMsg, type MsgMail } from './outlookMsg.js';

/**
 * An Outlook email saved as a .msg file and uploaded by hand, the way a PO often arrives:
 * the order is an attachment (a PDF or an Excel schedule), the email only carries it. The
 * email is opened and each PO attachment becomes a record of its own, exactly as the
 * Outlook intake does with mail it reads from the mailbox. The .msg itself is not stored.
 */

export interface EmailPo {
  name: string;
  content: Buffer;
  kind: DocumentKind;
  mimetype: string;
}

export interface OpenedEmail {
  mail: MsgMail;
  pos: EmailPo[];
  /** Attachments passed over: logos, Word files, an old .xls. */
  ignored: string[];
  legacyExcel: string[];
}

/** True for an Outlook .msg (an OLE file holding mail properties); false for an old .xls or .doc. */
export function isOutlookMessage(buffer: Buffer): boolean {
  if (!looksLikeOle(buffer)) return false;
  try {
    readMsg(buffer);
    return true;
  } catch {
    return false;
  }
}

/** The PO files in an email, including those inside an email attached to it (a forwarded mail). */
export function openEmail(buffer: Buffer, depth = 0): OpenedEmail {
  const mail = readMsg(buffer);
  const out: OpenedEmail = { mail, pos: [], ignored: [...mail.skippedAttachments], legacyExcel: [] };
  for (const a of mail.attachments) {
    const kind = detectDocumentKind(a.content, a.name);
    if (kind) {
      out.pos.push({ name: a.name, content: a.content, kind, mimetype: MIME_TYPES[kind] });
    } else if (depth < 2 && isOutlookMessage(a.content)) {
      const inner = openEmail(a.content, depth + 1);
      out.pos.push(...inner.pos);
      out.ignored.push(...inner.ignored);
      out.legacyExcel.push(...inner.legacyExcel);
    } else if (looksLikeLegacyExcel(a.content)) {
      out.legacyExcel.push(a.name);
    } else {
      out.ignored.push(a.name);
    }
  }
  return out;
}

/** The note a record from this email carries: who sent it, when, and the subject. */
export function emailNote(mail: MsgMail, filename: string): string {
  const when = mail.sentAt ? ` on ${mail.sentAt.toISOString().slice(0, 10)}` : '';
  return `From the email "${mail.subject || filename}"${mail.from ? ` sent by ${mail.from}` : ''}${when} (uploaded as ${filename})`;
}

/** Why an email gave no record, in words for the person who uploaded it. */
export function noPoReason(filename: string, opened: OpenedEmail): string {
  if (opened.legacyExcel.length) {
    return `${filename} is an email whose spreadsheet is an Excel 97–2003 workbook (${opened.legacyExcel.join(', ')}). Open it in Excel, save it as .xlsx, and upload that.`;
  }
  const names = [...opened.ignored];
  return names.length
    ? `${filename} is an email with no PDF or Excel PO attached (attachments: ${names.join(', ')}).`
    : `${filename} is an email with no attachments, so there is no PO to read.`;
}
