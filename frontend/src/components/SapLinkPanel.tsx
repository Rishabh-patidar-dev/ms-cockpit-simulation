import { useState } from 'react';
import type { RecordDetail } from '../lib/types';

/** Copies text; falls back to a hidden textarea where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * The link to share with SAP or a colleague for this order: the same address SAP's job calls.
 * It works only while the order waits for SAP; otherwise the box says why. The key is never shown.
 */
export function SapLinkPanel({ d }: { d: RecordDetail }) {
  const link = d.sapLink;
  const [copied, setCopied] = useState<string | null>(null);
  if (!link) return null;

  const r = d.record;
  const po = r.header?.poNumber ?? r.correlationId;
  const customer = r.header?.customerName;
  const shareUrl = link.downloadUrl ?? link.orderCsvUrl;
  const message = [
    `SAP order file for PO ${po}${customer ? ` (${customer})` : ''}`,
    '',
    link.downloadUrl ? 'Tap to download (no login needed):' : `Sign in with username "${link.user}" and the SAP API key:`,
    shareUrl,
    '',
    'The link works until SAP posts its answer for this order.',
  ].join('\n');

  const copy = async (what: string, text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    }
  };

  return (
    <section className="sec">
      <div className="sec-head">
        <h2>SAP link</h2>
        <span className="count-chip">{link.ready ? 'ready to share' : 'not available yet'}</span>
      </div>

      {link.ready && link.simulatorRunning && (
        <div className="notice t-warn" style={{ marginBottom: 10 }}>
          <b>The SAP simulator is running</b>
          <span>It answers orders within seconds, so this link stops working almost at once. Set RUN_SAP_SIMULATOR=false while the real SAP fetches orders.</span>
        </div>
      )}
      {!link.ready && (
        <div className="notice t-info" style={{ marginBottom: 10 }}>
          <span>{link.reason}</span>
        </div>
      )}

      <dl className="kv">
        {link.downloadUrl && (
          <>
            <dt>Tap to download</dt>
            <dd className="mono" style={{ opacity: link.ready ? 1 : 0.55 }}>
              {link.ready ? <a href={link.downloadUrl}>{link.downloadUrl}</a> : link.downloadUrl}
            </dd>
          </>
        )}
        <dt>For SAP's job</dt>
        <dd className="mono" style={{ opacity: link.ready ? 1 : 0.55 }}>{link.orderCsvUrl}</dd>
        <dt>All waiting orders</dt>
        <dd className="mono">{link.ordersUrl}</dd>
        <dt>Sign in</dt>
        <dd>
          {link.downloadUrl ? 'The tap-to-download link needs no login and opens only this order. ' : ''}
          The other two need username <span className="mono">{link.user}</span> and the SAP API key as password.
        </dd>
      </dl>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="sm" disabled={!link.ready} onClick={() => copy('link', shareUrl)}>
          {copied === 'link' ? 'Copied' : link.downloadUrl ? 'Copy tap-to-download link' : 'Copy link'}
        </button>
        <button className="sm" disabled={!link.ready} onClick={() => copy('message', message)}>
          {copied === 'message' ? 'Copied' : 'Copy message for a colleague'}
        </button>
        <button className="quiet sm" disabled={!link.apiEnabled} onClick={() => copy('list', link.ordersUrl)}>
          {copied === 'list' ? 'Copied' : 'Copy list link'}
        </button>
      </div>
    </section>
  );
}
