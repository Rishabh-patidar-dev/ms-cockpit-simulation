import { LINE_FIELDS, type ExtractionResult } from './types.js';
import { isAmbiguousDecimal } from './validation.js';

/**
 * Tidies a model's reading before it is stored. Two things only, both decided by the document
 * itself and never by a guess:
 *
 * 1. A line with no value in any field is dropped. Models sometimes return the total row or the
 *    blank space under the table as an empty line, which would otherwise block approval with
 *    "Material Code is required". A line with even one value is kept, so a half-read line still
 *    reaches the reviewer.
 *
 * 2. "4,000" is ambiguous on its own (four thousand, or four with three decimals), so validation
 *    reads it as a decimal and asks a person. When the same document prints numbers that show
 *    its convention, such as "3,360.00" (comma groups, dot is decimal) or "1.234,56", or
 *    "1,200,000" (a repeated separator can only group), the ambiguous values are written without
 *    the grouping mark: "4,000" becomes "4000". If the document shows both conventions, nothing
 *    is changed and the reviewer still decides.
 *
 * The model's untouched answer is kept in the extraction run's raw response.
 */
export function cleanExtraction(result: ExtractionResult): ExtractionResult {
  const nonEmpty = result.lineItems.filter((line) => LINE_FIELDS.some((f) => !isBlank(line[f]?.value)));
  const lineItems = nonEmpty.length > 0 ? nonEmpty : result.lineItems; // the schema needs at least one line

  const numbers = [
    result.header.poTotalValue?.value,
    ...lineItems.flatMap((l) => [l.quantity?.value, l.unitPrice?.value, l.lineNetValue?.value]),
  ];
  const group = documentGroupSeparator(numbers);
  if (!group) return { ...result, lineItems };

  const fix = <T extends { value: string | null } | undefined>(cv: T): T => {
    if (!cv || !cv.value || !isAmbiguousDecimal(cv.value) || !cv.value.includes(group)) return cv;
    return { ...cv, value: cv.value.split(group).join('') };
  };
  return {
    ...result,
    header: { ...result.header, poTotalValue: fix(result.header.poTotalValue) },
    lineItems: lineItems.map((l) => ({
      ...l,
      quantity: fix(l.quantity),
      unitPrice: fix(l.unitPrice),
      lineNetValue: fix(l.lineNetValue),
    })),
  };
}

/** The thousands separator the document's own numbers prove, or null if they prove none or both. */
export function documentGroupSeparator(values: (string | null | undefined)[]): ',' | '.' | null {
  const seen = new Set<',' | '.'>();
  for (const raw of values) {
    if (!raw) continue;
    const s = raw.replace(/[^\d,.]/g, '');
    const commas = s.split(',').length - 1;
    const dots = s.split('.').length - 1;
    if (commas > 0 && dots > 0) seen.add(s.lastIndexOf(',') > s.lastIndexOf('.') ? '.' : ',');
    else if (commas > 1) seen.add(',');
    else if (dots > 1) seen.add('.');
  }
  return seen.size === 1 ? [...seen][0]! : null;
}

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}
