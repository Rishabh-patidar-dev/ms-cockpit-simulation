import { describe, expect, it } from 'vitest';
import { assessForBulkApproval, type ApprovalFacts } from './bulkApproval.js';

const clean: ApprovalFacts = {
  status: 'NEEDS_REVIEW',
  uploadedById: 'uploader-1',
  actorId: 'approver-1',
  requireSeparateApprover: true,
  issues: [],
  unsureFields: 0,
  sentBack: false,
  duplicates: 0,
};

const codes = (f: Partial<ApprovalFacts>) => assessForBulkApproval({ ...clean, ...f }).holds.map((h) => h.code);

describe('which records may be approved in a batch', () => {
  it('accepts a record with nothing raised against it', () => {
    expect(assessForBulkApproval(clean)).toEqual({ clean: true, holds: [] });
  });

  it('accepts a warning a person has already accepted', () => {
    expect(codes({ issues: [{ severity: 'WARNING', acknowledged: true }] })).toEqual([]);
  });

  it('holds back a warning nobody has accepted, and counts it', () => {
    const a = assessForBulkApproval({
      ...clean,
      issues: [
        { severity: 'WARNING', acknowledged: false },
        { severity: 'WARNING', acknowledged: false },
        { severity: 'WARNING', acknowledged: true },
      ],
    });
    expect(a.clean).toBe(false);
    expect(a.holds).toEqual([{ code: 'WARNINGS', message: '2 warnings to check' }]);
  });

  it('holds back a blocking issue, in the singular for one', () => {
    expect(assessForBulkApproval({ ...clean, issues: [{ severity: 'BLOCKING', acknowledged: false }] }).holds).toEqual([
      { code: 'ISSUES', message: '1 issue to fix' },
    ]);
  });

  it('holds back fields the reading was unsure of', () => {
    expect(assessForBulkApproval({ ...clean, unsureFields: 3 }).holds).toEqual([
      { code: 'UNSURE_FIELDS', message: '3 fields the reading was unsure of' },
    ]);
  });

  it('holds back a repeat of another record, and one that was sent back', () => {
    expect(codes({ duplicates: 1 })).toEqual(['DUPLICATE']);
    expect(codes({ sentBack: true })).toEqual(['SENT_BACK']);
  });

  it("holds back the approver's own upload while a separate approver is required", () => {
    expect(codes({ uploadedById: 'approver-1' })).toEqual(['OWN_UPLOAD']);
    expect(codes({ uploadedById: 'approver-1', requireSeparateApprover: false })).toEqual([]);
  });

  it('says nothing more about a record that is not in review at all', () => {
    expect(codes({ status: 'APPROVED', unsureFields: 4, duplicates: 1 })).toEqual(['NOT_IN_REVIEW']);
  });

  it('lists every reason, not just the first', () => {
    expect(codes({ unsureFields: 1, duplicates: 1, issues: [{ severity: 'BLOCKING', acknowledged: false }] })).toEqual([
      'ISSUES',
      'UNSURE_FIELDS',
      'DUPLICATE',
    ]);
  });
});
