import type { POStatus } from '@prisma/client';

export const SAP_API_PATH = '/api/integration/sap';

export interface SapLinkConfig {
  sapApiPublicUrl: string;
  renderExternalUrl: string;
  publicBaseUrl: string;
  apiKeySet: boolean;
  apiUser: string;
  simulatorRunning: boolean;
}

export interface SapLink {
  /** Whether SAP can fetch this order through the link right now. */
  ready: boolean;
  /** Why not, in a sentence for the reviewer; null when ready. */
  reason: string | null;
  orderCsvUrl: string;
  ordersUrl: string;
  user: string;
  apiEnabled: boolean;
  simulatorRunning: boolean;
}

/** The server SAP should call: the explicit setting, else Render's own address, else the app's address. */
export function sapBaseUrl(cfg: SapLinkConfig): string {
  const base = cfg.sapApiPublicUrl || cfg.renderExternalUrl || cfg.publicBaseUrl;
  return base.trim().replace(/\/+$/, '');
}

/**
 * The link a person shares with SAP (or a colleague) for one order: the same address the SAP job
 * calls, GET /orders/{correlationId}/csv. It is only answered while the order waits for SAP, so the
 * reason says what to do when it is not.
 */
export function sapLinkFor(status: POStatus, correlationId: string, soNumber: string | null, cfg: SapLinkConfig): SapLink {
  const api = `${sapBaseUrl(cfg)}${SAP_API_PATH}`;
  const reason = !cfg.apiKeySet
    ? 'The SAP API is switched off. Set SAP_API_KEY on the server.'
    : status === 'SENT_TO_SAP'
      ? null
      : status === 'SO_CREATED'
        ? `SAP has already answered${soNumber ? ` with Sales Order ${soNumber}` : ''}, so the link no longer returns this order.`
        : status === 'CANCELLED'
          ? 'This PO was cancelled and will never be sent to SAP.'
          : status === 'FAILED'
            ? 'SAP rejected this order. Send it back to review, correct it and approve it again for a new link.'
            : status === 'APPROVED'
              ? 'Approved; the link works as soon as the order is sent to SAP, in a few seconds.'
              : 'Approve this PO first. The link works while the order is waiting for SAP.';
  return {
    ready: reason === null,
    reason,
    orderCsvUrl: `${api}/orders/${encodeURIComponent(correlationId)}/csv`,
    ordersUrl: `${api}/orders`,
    user: cfg.apiUser,
    apiEnabled: cfg.apiKeySet,
    simulatorRunning: cfg.simulatorRunning,
  };
}
