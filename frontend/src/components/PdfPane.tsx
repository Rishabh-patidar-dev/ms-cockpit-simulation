import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * FR-7.1 — the original PDF, held next to the reading of it. A spreadsheet or Outlook email is
 * shown as the text the extractor read, with the original file offered as a download.
 *
 * The document sits behind an authorised endpoint (NFR-3.5), so it is fetched as a
 * blob and shown through an object URL rather than linked directly. Page navigation,
 * zoom and text search come from the browser's own PDF viewer; a milestone-2 pdf.js
 * pane would add per-field source highlighting (FR-7.4), which needs coordinates the
 * extractor does not return yet.
 */
export function PdfPane({
  recordId, filename, kind = 'source', mimeType,
}: { recordId: string; filename: string; kind?: 'source' | 'salesOrder'; mimeType?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const isSo = kind === 'salesOrder';
  // A spreadsheet or Outlook email: the browser cannot show it, so the pane shows its text and offers the file.
  const isText = !isSo && !!mimeType && mimeType !== 'application/pdf' && !mimeType.startsWith('image/');

  useEffect(() => {
    setPreview(null);
    if (!isText) return;
    let cancelled = false;
    api
      .documentPreview(recordId)
      .then((p) => !cancelled && setPreview(p.text || '(Nothing readable in this document.)'))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error && err.message ? err.message : 'The document could not be read.'));
    return () => {
      cancelled = true;
    };
  }, [recordId, isText]);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);

    (isSo ? api.salesOrderUrl(recordId) : api.documentUrl(recordId))
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        revoked = objectUrl;
        setUrl(objectUrl);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof Error && err.message
            ? err.message
            : `The ${isSo ? 'Sales Order PDF' : 'source document'} could not be loaded. Try reloading the page.`,
        ),
      );

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [recordId, isSo]);

  return (
    <div className="doc">
      <div className="doc-bar">
        <span className="cap">{isSo ? 'Sales order' : 'Source'}</span>
        <span className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filename}>
          {filename}
        </span>
        <div className="spacer" />
        {url && (isText
          ? <a href={url} download={filename}>Download</a>
          : <a href={url} target="_blank" rel="noreferrer">Open</a>)}
      </div>
      {error ? (
        <div className="empty">{error}</div>
      ) : isText ? (
        preview === null ? <div className="empty">Reading document…</div> : <pre className="doc-text">{preview}</pre>
      ) : url ? (
        <iframe src={`${url}#view=FitH`} title={isSo ? 'Sales Order PDF' : 'Original purchase order PDF'} />
      ) : (
        <div className="empty">Loading document…</div>
      )}
    </div>
  );
}
