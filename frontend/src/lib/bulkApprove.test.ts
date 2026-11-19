import { describe, expect, it } from 'vitest';
import { holdSummary, readyIds, summariseBulk } from './bulkApprove';

const rows = [
  { id: 'a', status: 'NEEDS_REVIEW' as const },
  { id: 'b', status: 'NEEDS_REVIEW' as const },
  { id: 'c', status: 'NEEDS_REVIEW' as const },
  { id: 'd', status: 'APPROVED' as const },
];

describe('which rows can be approved together', () => {
  it('takes the rows the server calls clean, in list order', () => {
    const readiness = {
      a: { clean: true, holds: [] },
      b: { clean: false, holds: [{ code: 'WARNINGS', message: '2 warnings to check' }] },
      c: { clean: true, holds: [] },
    };
    expect(readyIds(rows, readiness)).toEqual(['a', 'c']);
  });

  it('takes nothing before the server has answered, or for a row it did not assess', () => {
    expect(readyIds(rows, undefined)).toEqual([]);
    expect(readyIds(rows, { a: { clean: true, holds: [] } })).toEqual(['a']);
  });

  it('never takes a row that is no longer in review, whatever the answer was', () => {
    expect(readyIds(rows, { d: { clean: true, holds: [] } })).toEqual([]);
  });
});

describe('saying why a row is held back', () => {
  it('gives the first reason alone when there is only one', () => {
    expect(holdSummary({ clean: false, holds: [{ code: 'DUPLICATE', message: 'Looks like a repeat of another record' }] })).toBe(
      'Looks like a repeat of another record',
    );
  });

  it('counts the rest', () => {
    expect(
      holdSummary({
        clean: false,
        holds: [
          { code: 'ISSUES', message: '1 issue to fix' },
          { code: 'UNSURE_FIELDS', message: '3 fields the reading was unsure of' },
          { code: 'DUPLICATE', message: 'Looks like a repeat of another record' },
        ],
      }),
    ).toBe('1 issue to fix (+2 more)');
  });

  it('says nothing for a clean row', () => {
    expect(holdSummary({ clean: true, holds: [] })).toBe('');
  });
});

describe('summarising a batch', () => {
  it('counts what happened to each', () => {
    expect(
      summariseBulk([
        { id: 'a', result: 'approved' },
        { id: 'b', result: 'held', holds: [] },
        { id: 'c', result: 'failed', code: 'CONCURRENT_UPDATE', message: 'x' },
        { id: 'd', result: 'approved' },
      ]),
    ).toEqual({ approved: 2, held: 1, failed: 1 });
  });
});
