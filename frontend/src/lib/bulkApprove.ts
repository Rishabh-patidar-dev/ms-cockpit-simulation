import type { BulkOutcome, Readiness, WorklistRow } from './types';

/**
 * Approving from the list is for the records nobody needs to look at. The server decides which
 * those are (see backend/src/domain/bulkApproval.ts) and checks again when asked to approve;
 * this only reads its answer.
 */

/** The rows in the list the server says could go in a batch, in list order. */
export const readyIds = (
  rows: Pick<WorklistRow, 'id' | 'status'>[],
  readiness: Record<string, Readiness> | undefined,
): string[] => rows.filter((r) => r.status === 'NEEDS_REVIEW' && readiness?.[r.id]?.clean).map((r) => r.id);

/** One line for a record that is not ready: the first reason, and how many more there are. */
export function holdSummary(r: Readiness): string {
  const [first, ...rest] = r.holds;
  if (!first) return '';
  return rest.length ? `${first.message} (+${rest.length} more)` : first.message;
}

export function summariseBulk(outcomes: BulkOutcome[]) {
  return {
    approved: outcomes.filter((o) => o.result === 'approved').length,
    held: outcomes.filter((o) => o.result === 'held').length,
    failed: outcomes.filter((o) => o.result === 'failed').length,
  };
}
