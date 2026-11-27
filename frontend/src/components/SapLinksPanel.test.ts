import { describe, expect, it } from 'vitest';
import { sapLinksMessage } from './SapLinksPanel';

describe('sapLinksMessage', () => {
  it('lists every waiting order with its link, numbered, ready to paste into a message', () => {
    const text = sapLinksMessage([
      { recordId: 'r1', correlationId: 'PO-A', poNumber: 'ARS-PO-61590', customerName: 'Alpine Rail', lines: 11, sentToSapAt: null, overdue: false, downloadUrl: 'https://x/api/integration/sap/orders/PO-A/csv?token=t1', orderCsvUrl: 'https://x/a' },
      { recordId: 'r2', correlationId: 'PO-B', poNumber: null, customerName: null, lines: 1, sentToSapAt: null, overdue: true, downloadUrl: null, orderCsvUrl: 'https://x/api/integration/sap/orders/PO-B/csv' },
    ]);
    expect(text.split('\n')).toEqual([
      'SAP order files waiting for a Sales Order (2).',
      'Each link downloads one order as the CSV SAP reads; no login needed. A link works until SAP posts its answer for that order.',
      '',
      '1. PO ARS-PO-61590 · Alpine Rail · 11 lines',
      '   https://x/api/integration/sap/orders/PO-A/csv?token=t1',
      '2. PO PO-B · 1 line',
      '   https://x/api/integration/sap/orders/PO-B/csv',
    ]);
  });
});
