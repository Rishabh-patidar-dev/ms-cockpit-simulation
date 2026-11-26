import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { isSpreadsheetType } from '../lib/fileKinds';
import type { RecordDetail } from '../lib/types';
import { PdfPane } from './PdfPane';

/** Excel's column name: 1 → A, 27 → AA. */
export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * A spreadsheet PO, shown as its cells next to the reading of it — the spreadsheet's
 * counterpart of PdfPane. Row numbers and column letters are Excel's own, so a cell the
 * reading came from (P7) can be found by eye. Cells the customer hid in Excel are shown
 * faded rather than left out, since the reading may have used them as labels.
 */
export function SheetPane({ recordId, filename }: { recordId: string; filename: string }) {
  const data = useQuery({ queryKey: ['document-sheets', recordId], queryFn: () => api.documentSheets(recordId), staleTime: Infinity });
  const [active, setActive] = useState(0);
  const [download, setDownload] = useState<string | null>(null);

  // The original file, fetched behind auth, offered as a download.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api.documentUrl(recordId).then(
      (u) => (cancelled ? URL.revokeObjectURL(u) : setDownload((url = u))),
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [recordId]);

  const sheets = data.data?.sheets ?? [];
  const sheet = sheets[Math.min(active, Math.max(0, sheets.length - 1))];
  const hiddenRows = new Set(sheet?.hiddenRows);
  const hiddenCols = new Set(sheet?.hiddenColumns);
  const width = Math.max(0, ...(sheet?.rows ?? []).map((r) => r.length));

  return (
    <div className="doc">
      <div className="doc-bar">
        <span className="cap">Source</span>
        <span className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filename}>
          {filename}
        </span>
        <div className="spacer" />
        {download && (
          <a href={download} download={filename}>
            Download
          </a>
        )}
      </div>
      {sheets.length > 1 && (
        <div className="sheet-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              role="tab"
              className="tab"
              aria-selected={i === active}
              aria-pressed={i === active}
              onClick={() => setActive(i)}
              title={s.hidden ? 'Hidden in Excel; not used for the reading' : undefined}
            >
              {s.name}
              {s.hidden ? ' (hidden)' : ''}
            </button>
          ))}
        </div>
      )}
      {data.isError ? (
        <div className="empty">{data.error instanceof Error ? data.error.message : 'The spreadsheet could not be loaded.'}</div>
      ) : !sheet ? (
        <div className="empty">{data.isPending ? 'Loading spreadsheet…' : 'The spreadsheet is empty.'}</div>
      ) : (
        <>
          {(sheet.hidden || hiddenCols.size > 0 || hiddenRows.size > 0 || sheet.truncated) && (
            <div className="sheet-note faint">
              {sheet.hidden
                ? 'This sheet is hidden in Excel and was not used for the reading.'
                : 'Faded cells are hidden in Excel.'}
              {sheet.truncated ? ' The sheet is very large; only its first part is shown and was read.' : ''}
            </div>
          )}
          <div className="sheet-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th className="corner" />
                  {Array.from({ length: width }, (_, c) => (
                    <th key={c} className={hiddenCols.has(c + 1) ? 'is-hidden' : undefined}>
                      {columnLetter(c + 1)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, r) => (
                  <tr key={r} className={hiddenRows.has(r + 1) ? 'is-hidden' : undefined}>
                    <th>{r + 1}</th>
                    {Array.from({ length: width }, (_, c) => {
                      const v = row[c] ?? '';
                      return (
                        <td
                          key={c}
                          className={[hiddenCols.has(c + 1) ? 'is-hidden' : '', /^-?[\d.,]+$/.test(v) ? 'num' : ''].join(' ').trim() || undefined}
                          title={v.length > 40 ? `${columnLetter(c + 1)}${r + 1}: ${v}` : `${columnLetter(c + 1)}${r + 1}`}
                        >
                          {v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** The record's source document: a PDF in the browser's viewer, or a spreadsheet as cells. */
export function SourcePane({ recordId, doc }: { recordId: string; doc: NonNullable<RecordDetail['record']['sourceDocument']> }) {
  return isSpreadsheetType(doc.mimeType) ? (
    <SheetPane recordId={recordId} filename={doc.originalFilename} />
  ) : (
    <PdfPane recordId={recordId} filename={doc.originalFilename} />
  );
}
