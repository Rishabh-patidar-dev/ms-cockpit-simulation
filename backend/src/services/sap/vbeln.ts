/**
 * The Business Command Centre's Sales Order number, as SAP's VBELN (CHAR10) expects it.
 *
 * SAP stores VBELN through the ALPHA conversion exit: a purely numeric value is
 * left-padded with zeros to the full ten characters ("12345" → "0000012345"), and
 * anything else is kept left-aligned as typed. An ABAP SELECT on VBELN matches the
 * padded form only, so sending "12345" to ZEE_API_LOG finds nothing rather than
 * failing loudly — which is why the padding happens here, once, and is tested.
 *
 * A value longer than ten characters is refused, never truncated: truncating a
 * document number is how you end up reading the log of a different Sales Order.
 */
export const VBELN_LENGTH = 10;

export class VbelnError extends Error {}

/**
 * The Sales Order number out of the body of SAP's answer, which carries nothing else (the order
 * is named in the URL). SAP's own field name is VBELN; soNumber and the sales_orders that its
 * first, non-JSON attempt used are accepted too. The body may be a JSON object, form fields, or
 * the bare number as plain text.
 *
 * Strict on purpose: this number is attached to a PO on the strength of the URL alone, so a body
 * that holds several numbers, or anything that is not ten letters-or-digits at most, is refused
 * rather than cut down to something that looks right.
 */
const SO_NUMBER_FIELDS = ['vbeln', 'sonumber', 'salesorder', 'salesorders'];

export function soNumberFromBody(body: unknown): string {
  let raw: unknown = body;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k.replace(/_/g, '').toLowerCase(), v]),
    );
    raw = SO_NUMBER_FIELDS.map((k) => fields[k]).find((v) => v != null && String(v).trim() !== '');
  }
  const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!value) {
    throw new VbelnError(
      'No Sales Order number found. Send {"VBELN":"4500387184"}, the form field VBELN=4500387184, or the number alone as plain text.',
    );
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(value)) {
    const shown = value.slice(0, 24).replace(/[^\x20-\x7e]/g, '?');
    throw new VbelnError(
      `"${shown}" is not a Sales Order number: VBELN is one value of up to ${VBELN_LENGTH} letters or digits.`,
    );
  }
  return value;
}

export function toVbeln(soNumber: string | null | undefined): string {
  const value = (soNumber ?? '').trim().toUpperCase();
  if (!value) throw new VbelnError('There is no Sales Order number to send as VBELN.');
  if (value.length > VBELN_LENGTH) {
    throw new VbelnError(
      `Sales Order number "${value}" is ${value.length} characters; VBELN is CHAR${VBELN_LENGTH}.`,
    );
  }
  if (!/^[A-Z0-9]+$/.test(value)) {
    throw new VbelnError(`Sales Order number "${value}" contains characters VBELN cannot hold.`);
  }
  return /^\d+$/.test(value) ? value.padStart(VBELN_LENGTH, '0') : value;
}
