import type { ValidationIssue } from './validation.js';

/**
 * Approving several records at once is only for the ones nobody needs to look at. This decides
 * which those are, and says why for each one that is not.
 *
 * It is stricter than approving a record on its own screen. There, an approver can read a
 * flagged field, accept a warning and approve; a batch skips the reading, so anything a person
 * would have had to decide — a blocking issue, a warning nobody has accepted, a field the model
 * was unsure of and nobody has corrected, a repeat of another PO, a record sent back — keeps the
 * record out of the batch and leaves it for its own screen.
 */
export type HoldCode =
  | 'NOT_IN_REVIEW'
  | 'OWN_UPLOAD'
  | 'SENT_BACK'
  | 'ISSUES'
  | 'WARNINGS'
  | 'UNSURE_FIELDS'
  | 'DUPLICATE';

export interface Hold {
  code: HoldCode;
  message: string;
}

export interface Assessment {
  clean: boolean;
  holds: Hold[];
}

export interface ApprovalFacts {
  status: string;
  uploadedById: string;
  actorId: string;
  requireSeparateApprover: boolean;
  /** As the review screen shows them: each warning says whether a person has accepted it. */
  issues: (Pick<ValidationIssue, 'severity'> & { acknowledged: boolean })[];
  /** Fields the reading was unsure of that nobody has corrected since. */
  unsureFields: number;
  /** The record is back in review because an approver sent it back (FR-7.12). */
  sentBack: boolean;
  /** Other live records with the same PO number and customer, or the same PDF. */
  duplicates: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function assessForBulkApproval(f: ApprovalFacts): Assessment {
  const holds: Hold[] = [];

  if (f.status !== 'NEEDS_REVIEW') {
    holds.push({ code: 'NOT_IN_REVIEW', message: 'No longer waiting for review' });
    return { clean: false, holds };
  }
  if (f.requireSeparateApprover && f.uploadedById === f.actorId) {
    holds.push({ code: 'OWN_UPLOAD', message: 'You uploaded this one, so another approver has to approve it' });
  }
  if (f.sentBack) {
    holds.push({ code: 'SENT_BACK', message: 'It was sent back; open it to check the fix' });
  }
  const blocking = f.issues.filter((i) => i.severity === 'BLOCKING').length;
  if (blocking > 0) {
    holds.push({ code: 'ISSUES', message: `${plural(blocking, 'issue', 'issues')} to fix` });
  }
  const unaccepted = f.issues.filter((i) => i.severity === 'WARNING' && !i.acknowledged).length;
  if (unaccepted > 0) {
    holds.push({ code: 'WARNINGS', message: `${plural(unaccepted, 'warning', 'warnings')} to check` });
  }
  if (f.unsureFields > 0) {
    holds.push({
      code: 'UNSURE_FIELDS',
      message: `${plural(f.unsureFields, 'field', 'fields')} the reading was unsure of`,
    });
  }
  if (f.duplicates > 0) {
    holds.push({ code: 'DUPLICATE', message: 'Looks like a repeat of another record' });
  }

  return { clean: holds.length === 0, holds };
}
