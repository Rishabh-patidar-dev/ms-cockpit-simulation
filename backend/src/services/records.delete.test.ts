import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deleting a record is a soft delete (FR-2.3, DM-04): the row is hidden, the audit trail stays. A draft is
// deleted by anyone who can see it; once a record has reached SAP, only an approver or administrator can.

let current: Record<string, unknown> | null;
const update = vi.fn();
const auditCreate = vi.fn();

vi.mock('../db/client.js', () => ({
  prisma: {
    pORecord: { findFirst: vi.fn(async () => current), update: (...a: unknown[]) => update(...a) },
    auditEvent: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}));

const { deleteRecord } = await import('./records.js');
const uploader = { id: 'u1', role: 'UPLOADER' as const, name: 'Uploader' };
const approver = { id: 'u2', role: 'APPROVER' as const, name: 'Approver' };
const record = (status: string) => ({ id: 'r1', correlationId: 'PO-R1', status, deletedAt: null });
const audited = () => auditCreate.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  current = record('DRAFT');
});

describe('deleting a record', () => {
  it('deletes a draft, as before', async () => {
    await deleteRecord(uploader, 'r1');
    expect(update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { deletedAt: expect.any(Date) } });
    expect(audited()[0]).toMatchObject({ eventType: 'RECORD_DELETED', message: 'Draft deleted', actorId: 'u1' });
  });

  it.each(['NEEDS_REVIEW', 'EXTRACTION_FAILED', 'CANCELLED'])('lets anyone delete a record in %s, and says what it was', async (status) => {
    current = record(status);
    await deleteRecord(uploader, 'r1');
    expect(update).toHaveBeenCalledTimes(1);
    expect(audited()[0]).toMatchObject({ eventType: 'RECORD_DELETED', message: `Deleted while ${status}` });
  });

  it.each(['APPROVED', 'SENT_TO_SAP', 'FAILED', 'SO_CREATED'])('lets an approver delete a record that has gone to SAP (%s)', async (status) => {
    current = record(status);
    await deleteRecord(approver, 'r1');
    expect(update).toHaveBeenCalledTimes(1);
    expect(audited()[0]).toMatchObject({ eventType: 'RECORD_DELETED', message: `Deleted while ${status}`, actorId: 'u2' });
  });

  it.each(['APPROVED', 'SENT_TO_SAP', 'FAILED', 'SO_CREATED'])('refuses anyone else a record that has gone to SAP (%s)', async (status) => {
    current = record(status);
    await expect(deleteRecord(uploader, 'r1')).rejects.toMatchObject({ status: 403 });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each(['PUBLISHED', 'PROCESSING'])('refuses a record that is being read (%s)', async (status) => {
    current = record(status);
    await expect(deleteRecord(approver, 'r1')).rejects.toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
  });
});
