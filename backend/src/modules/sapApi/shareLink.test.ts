import { describe, expect, it } from 'vitest';
import { sapBaseUrl, sapLinkFor, type SapLinkConfig } from './shareLink.js';

const cfg = (over: Partial<SapLinkConfig> = {}): SapLinkConfig => ({
  sapApiPublicUrl: '',
  renderExternalUrl: 'https://bcc-outlook-intake.onrender.com',
  publicBaseUrl: 'https://bcc-outlook-intake.vercel.app',
  apiKey: 'test-key',
  apiUser: 'sap',
  simulatorRunning: false,
  ...over,
});

describe('sapBaseUrl', () => {
  it('prefers the explicit setting, then Render, then the app address', () => {
    expect(sapBaseUrl(cfg({ sapApiPublicUrl: 'https://sap.example/' }))).toBe('https://sap.example');
    expect(sapBaseUrl(cfg())).toBe('https://bcc-outlook-intake.onrender.com');
    expect(sapBaseUrl(cfg({ renderExternalUrl: '' }))).toBe('https://bcc-outlook-intake.vercel.app');
  });
});

describe('sapLinkFor', () => {
  it('builds the same address the SAP job calls', () => {
    const link = sapLinkFor('SENT_TO_SAP', 'PO-8A5FED59AEAE45F9AAEAE6D8FA4024B6', null, cfg());
    expect(link.ready).toBe(true);
    expect(link.reason).toBeNull();
    expect(link.orderCsvUrl).toBe(
      'https://bcc-outlook-intake.onrender.com/api/integration/sap/orders/PO-8A5FED59AEAE45F9AAEAE6D8FA4024B6/csv',
    );
    expect(link.ordersUrl).toBe('https://bcc-outlook-intake.onrender.com/api/integration/sap/orders');
    expect(link.user).toBe('sap');
    expect(link.downloadUrl).toMatch(/\/orders\/PO-8A5FED59AEAE45F9AAEAE6D8FA4024B6\/csv\?token=[0-9a-f]{40}$/);
  });

  it.each([
    ['NEEDS_REVIEW', /Approve this PO first/],
    ['APPROVED', /in a few seconds/],
    ['SO_CREATED', /Sales Order 4500012345/],
    ['FAILED', /rejected/],
    ['CANCELLED', /cancelled/],
  ] as const)('is not ready in %s and says why', (status, reason) => {
    const link = sapLinkFor(status, 'PO-1', '4500012345', cfg());
    expect(link.ready).toBe(false);
    expect(link.reason).toMatch(reason);
  });

  it('stays ready for an order past the wait that SAP has not answered, but not for one SAP rejected', () => {
    expect(sapLinkFor('FAILED', 'PO-1', null, cfg(), 'NO_RESPONSE_FROM_SAP')).toMatchObject({ ready: true, reason: null });
    expect(sapLinkFor('FAILED', 'PO-1', null, cfg(), 'SAP_REJECTED').ready).toBe(false);
  });

  it('is not ready when the SAP API is off, whatever the status', () => {
    const link = sapLinkFor('SENT_TO_SAP', 'PO-1', null, cfg({ apiKey: '' }));
    expect(link.ready).toBe(false);
    expect(link.reason).toMatch(/SAP_API_KEY/);
    expect(link.downloadUrl).toBeNull();
  });
});
