import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { WaitingOrderLink } from '../lib/types';
import { copyText } from './SapLinkPanel';

const label = (l: WaitingOrderLink) =>
  `PO ${l.poNumber ?? l.correlationId}${l.customerName ? ` · ${l.customerName}` : ''} · ${l.lines} line${l.lines === 1 ? '' : 's'}`;

/** The message to send a colleague testing SAP's side: every waiting order and its link. */
export function sapLinksMessage(links: WaitingOrderLink[]): string {
  return [
    `SAP order files waiting for a Sales Order (${links.length}).`,
    'Each link downloads one order as the CSV SAP reads; no login needed. A link works until SAP posts its answer for that order.',
    '',
    ...links.flatMap((l, i) => [`${i + 1}. ${label(l)}`, `   ${l.downloadUrl ?? l.orderCsvUrl}`]),
  ].join('\n');
}

/**
 * Every order SAP can fetch right now, with its link: the list to hand whoever is testing the SAP
 * side, instead of opening the orders one by one. The links carry a code for that order only, never
 * the API key.
 */
export function SapLinksPanel({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['sap-links'], queryFn: api.sapLinks, refetchInterval: 10000 });
  const [copied, setCopied] = useState<string | null>(null);
  const links = q.data?.links ?? [];

  const copy = async (what: string, text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    }
  };

  return (
    <section className="sec" style={{ marginTop: 12 }}>
      <div className="sec-head">
        <h2>SAP links</h2>
        <span className="count-chip">{q.isLoading ? 'loading' : `${links.length} waiting for SAP`}</span>
        <div className="spacer" />
        <button className="quiet sm" disabled={!links.length} onClick={() => copy('all', sapLinksMessage(links))}>
          {copied === 'all' ? 'Copied' : 'Copy all'}
        </button>
        <button className="quiet sm" onClick={onClose}>Close</button>
      </div>

      {q.error ? (
        <div className="err" role="alert">The links could not be loaded. Try again.</div>
      ) : q.data && !q.data.apiEnabled ? (
        <div className="notice t-warn">The SAP API is switched off, so there are no links to share. Set SAP_API_KEY on the server.</div>
      ) : (
        <>
          {q.data?.simulatorRunning && (
            <div className="notice t-warn" style={{ marginBottom: 10 }}>
              <b>The SAP simulator is running</b> and answers orders within seconds, so these links stop working almost at once.
            </div>
          )}
          {!q.isLoading && !links.length && (
            <div className="empty">No order is waiting for SAP. Approve a PO and its link appears here a few seconds later.</div>
          )}
          {links.length > 0 && (
            <table className="lines" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Customer</th>
                  <th>Lines</th>
                  <th>Link</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => {
                  const url = l.downloadUrl ?? l.orderCsvUrl;
                  return (
                    <tr key={l.correlationId}>
                      <td>
                        <Link to={`/records/${l.recordId}`}>{l.poNumber ?? l.correlationId}</Link>
                        {l.overdue && <span className="faint" title="SAP has not answered within the expected time; the link still works until it does."> · no answer yet</span>}
                      </td>
                      <td>{l.customerName ?? '—'}</td>
                      <td className="mono">{l.lines}</td>
                      <td className="mono" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={url}>
                        <a href={url} target="_blank" rel="noreferrer">{url}</a>
                      </td>
                      <td>
                        <button className="quiet sm" onClick={() => copy(l.correlationId, url)}>
                          {copied === l.correlationId ? 'Copied' : 'Copy'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
