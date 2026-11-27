import type { POStatus } from '@prisma/client';
import { orderCsvToken } from '../../middleware/sapApiAuth.js';

export const SAP_API_PATH = '/api/integration/sap';

export interface SapLinkConfig {
  sapApiPublicUrl: string;
  renderExternalUrl: string;
  publicBaseUrl: string;
  /** SAP_API_KEY; only used to make the tap-to-download code, never sent anywhere. */
  apiKey: string;
  apiUser: string;
  simulatorRunning: boolean;
}

export interface SapLink {
  /** Whether SAP can fetch this order through the link right now. */
  ready: boolean;
  /** Why not, in a sentence for the reviewer; null when ready. */
  reason: string | null;
  orderCsvUrl: string;
  /** The same CSV, opened by tapping: no login, this order only. Null while the SAP API is off. */
  downloadUrl: string | null;
  ordersUrl: string;
  user: string;
  apiEnabled: boolean;
  simulatorRunning: boolean;
}

/**
 * An order SAP has not answered: sent to it, or past the SAP_SLA_TIMEOUT_MS wait with no answer
 * (FAILED, NO_RESPONSE_FROM_SAP). The timeout alerts Operations; it does not take the order away
 * from SAP, whose late answer is still accepted, so the order stays fetchable until SAP answers.
 */
export const isWaitingForSap = (status: POStatus, failureCode: string | null | undefined) =>
  status === 'SENT_TO_SAP' || (status === 'FAILED' && failureCode === 'NO_RESPONSE_FROM_SAP');

/** The same, as a database filter. */
export const WAITING_FOR_SAP = [{ status: 'SENT_TO_SAP' as const }, { status: 'FAILED' as const, failureCode: 'NO_RESPONSE_FROM_SAP' }];

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
export function sapLinkFor(
  status: POStatus,
  correlationId: string,
  soNumber: string | null,
  cfg: SapLinkConfig,
  failureCode: string | null = null,
): SapLink {
  const api = `${sapBaseUrl(cfg)}${SAP_API_PATH}`;
  const reason = !cfg.apiKey
    ? 'The SAP API is switched off. Set SAP_API_KEY on the server.'
    : isWaitingForSap(status, failureCode)
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
  const orderCsvUrl = `${api}/orders/${encodeURIComponent(correlationId)}/csv`;
  return {
    ready: reason === null,
    reason,
    orderCsvUrl,
    downloadUrl: cfg.apiKey ? `${orderCsvUrl}?token=${orderCsvToken(correlationId, cfg.apiKey)}` : null,
    ordersUrl: `${api}/orders`,
    user: cfg.apiUser,
    apiEnabled: Boolean(cfg.apiKey),
    simulatorRunning: cfg.simulatorRunning,
  };
}
