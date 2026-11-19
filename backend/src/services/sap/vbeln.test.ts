import { describe, expect, it } from 'vitest';
import { VbelnError, soNumberFromBody, toVbeln } from './vbeln.js';

describe('soNumberFromBody (the answer that carries only the Sales Order number)', () => {
  it('reads VBELN from a JSON or form body, in any case, with or without underscores', () => {
    expect(soNumberFromBody({ VBELN: '4500387184' })).toBe('4500387184');
    expect(soNumberFromBody({ vbeln: ' 4500387184 ' })).toBe('4500387184');
    expect(soNumberFromBody({ so_number: '4500387184' })).toBe('4500387184');
    expect(soNumberFromBody({ sales_orders: '4500387184' })).toBe('4500387184');
  });

  it('keeps the leading zeros SAP writes, and takes a JSON number or a bare string', () => {
    expect(soNumberFromBody({ VBELN: '0000012345' })).toBe('0000012345');
    expect(soNumberFromBody({ VBELN: 4500387184 })).toBe('4500387184');
    expect(soNumberFromBody('4500387184\n')).toBe('4500387184');
  });

  it('refuses a body with no number in it', () => {
    for (const body of [undefined, null, {}, '', '   ', { VBELN: '' }, { other: '4500387184' }, ['4500387184']]) {
      expect(() => soNumberFromBody(body)).toThrow(VbelnError);
    }
  });

  it('refuses several numbers, or anything that is not a VBELN, instead of picking one', () => {
    expect(() => soNumberFromBody({ sales_orders: '4500387184,4500387185' })).toThrow(/not a Sales Order number/);
    expect(() => soNumberFromBody('4500387184 4500387185')).toThrow(VbelnError);
    expect(() => soNumberFromBody({ VBELN: '45003871849' })).toThrow(VbelnError);
    expect(() => soNumberFromBody({ VBELN: 'SO-123' })).toThrow(VbelnError);
  });
});

describe('toVbeln (CHAR10, ALPHA conversion)', () => {
  it('passes a full ten-digit S/4HANA number through unchanged', () => {
    expect(toVbeln('4500123456')).toBe('4500123456');
  });

  it('left-pads a short numeric number with zeros, as SAP stores it', () => {
    expect(toVbeln('12345')).toBe('0000012345');
    expect(toVbeln('  12345 ')).toBe('0000012345');
  });

  it('keeps an alphanumeric number left-aligned and upper-cased', () => {
    expect(toVbeln('so12345')).toBe('SO12345');
  });

  it('refuses a number longer than ten characters rather than truncating it', () => {
    expect(() => toVbeln('45001234567')).toThrow(VbelnError);
  });

  it('refuses an empty number and characters VBELN cannot hold', () => {
    expect(() => toVbeln(null)).toThrow(VbelnError);
    expect(() => toVbeln('   ')).toThrow(VbelnError);
    expect(() => toVbeln('SO-123')).toThrow(VbelnError);
  });
});
