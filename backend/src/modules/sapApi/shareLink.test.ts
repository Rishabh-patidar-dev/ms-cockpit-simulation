import { describe, expect, it } from 'vitest';
import { sapBaseUrl, sapLinkFor, type SapLinkConfig } from './shareLink.js';

const cfg = (over: Partial<SapLinkConfig> = {}): SapLinkConfig => ({
  sapApiPublicUrl: '',
  renderExternalUrl: 'https://bcc-outlook-intake.onrender.com',
  publicBaseUrl: 'https://bcc-outlook-intake.vercel.app',
  apiKeySet: true,
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

  it('is not ready when the SAP API is off, whatever the status', () => {
    const link = sapLinkFor('SENT_TO_SAP', 'PO-1', null, cfg({ apiKeySet: false }));
    expect(link.ready).toBe(false);
    expect(link.reason).toMatch(/SAP_API_KEY/);
  });
});
