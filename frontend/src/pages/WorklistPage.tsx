import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ACCEPT_ATTR, MAX_BATCH, NOT_ACCEPTED, isAcceptedFile, summarise, uploadAndPublishAll, type BatchOutcome } from '../lib/batchUpload';
import { holdSummary, readyIds, summariseBulk } from '../lib/bulkApprove';
import { parseDecimal } from '../lib/decimal';
import { ago } from '../lib/format';
import { readWorklist, rememberWorklist, writeWorklist, type SortKey, type WorklistState } from '../lib/worklistState';
import { StatusBadge } from '../components/StatusBadge';
import { statusTone, toneClass } from '../lib/status';
import type { BulkOutcome, POStatus, WorklistRow } from '../lib/types';

/** FR-12.4 — the views people actually work from. */
const VIEWS: { key: string; label: string; tone: string; statuses?: POStatus[]; mine?: boolean }[] = [
  { key: 'all', label: 'All', tone: 't-idle' },
  { key: 'review', label: 'Needs review', tone: 't-warn', statuses: ['NEEDS_REVIEW'] },
  { key: 'failed', label: 'Failed', tone: 't-crit', statuses: ['FAILED', 'EXTRACTION_FAILED'] },
  { key: 'inflight', label: 'In flight', tone: 't-info', statuses: ['APPROVED', 'SENT_TO_SAP'] },
  { key: 'draft', label: 'Incoming', tone: 't-info', statuses: ['DRAFT', 'PUBLISHED', 'PROCESSING'] },
  { key: 'done', label: 'SO created', tone: 't-ok', statuses: ['SO_CREATED'] },
  { key: 'mine', label: 'Mine', tone: 't-idle', mine: true },
];

// Read the way the validator reads amounts, so "1.245,00" sorts as 1245 and not 124500.
const num = (s?: string | null) => parseDecimal(s) ?? -Infinity;

const keyOf = (r: WorklistRow, k: SortKey): string | number => {
  switch (k) {
    case 'status': return r.status;
    case 'poNumber': return r.header?.poNumber ?? '';
    case 'customer': return r.header?.customerName ?? '';
    case 'lines': return r.header?._count.lineItems ?? 0;
    case 'value': return num(r.header?.poTotalValue);
    case 'soNumber': return r.soNumber ?? '';
    case 'soValue': return num(r.salesOrder?.value);
    case 'age': return new Date(r.statusChangedAt).getTime();
  }
};

/** Rows fetched per page; the server caps a page at 200. */
const PAGE_SIZE = 50;

/** The most records the server will assess for a batch in one call. */
const READINESS_MAX = 100;

export function WorklistPage() {
  // The view, the search and the sort live in the URL, so opening a record and coming back
  // (Back, the Worklist link, a reload) lands on the same list.
  const [params, setParams] = useSearchParams();
  const { view, q: urlQ, sort } = readWorklist(params, VIEWS.map((v) => v.key));
  const update = (patch: Partial<WorklistState>) =>
    setParams((prev) => writeWorklist({ ...readWorklist(prev, VIEWS.map((v) => v.key)), ...patch }), { replace: true });
  // What is typed shows at once; the URL, and so the query, follows 300 ms after the last key.
  const [q, setQ] = useState(urlQ);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // A multi-file drop: progress while it runs, then what happened to each file.
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<BatchOutcome[] | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { user } = useAuth();
  // The Outlook intake: emailed POs arrive on their own; the button checks the mailbox now.
  const mail = useQuery({ queryKey: ['mail-intake'], queryFn: api.mailIntakeStatus, refetchInterval: 30000 });
  const [mailNote, setMailNote] = useState<string | null>(null);
  const checkMail = useMutation({
    mutationFn: api.runMailIntake,
    onSuccess: (s) => {
      qc.setQueryData(['mail-intake'], s);
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
      setMailNote(s.lastError ? `Could not read the mailbox: ${s.lastError}` : null);
    },
    onError: (e) => setMailNote(e instanceof Error ? e.message : 'Could not check the mailbox.'),
  });

  // "Connect Outlook": off to Microsoft's sign-in page, which sends the browser back to /?mail=...
  const connectOutlook = useMutation({
    mutationFn: api.connectOutlook,
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => setMailNote(e instanceof Error ? e.message : 'Could not start the Outlook sign-in.'),
  });
  const canConnect = user?.role === 'ADMIN' || user?.role === 'OPERATIONS';
  const mailNeedsConnect = !!mail.data?.enabled && mail.data.authMode === 'delegated' &&
    (!mail.data.connection || /Connect Outlook/.test(mail.data.lastError ?? ''));
  const [connectResult] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const outcome = q.get('mail');
    return outcome === 'connected' || outcome === 'error' ? { ok: outcome === 'connected', detail: q.get('detail') ?? '' } : null;
  });
  const [connectNote, setConnectNote] = useState(connectResult);
  useEffect(() => {
    if (!connectResult) return;
    const q = new URLSearchParams(window.location.search);
    q.delete('mail');
    q.delete('detail');
    window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`);
  }, [connectResult]);

  const active = VIEWS.find((v) => v.key === view)!;

  useEffect(() => {
    if (q === urlQ) return;
    const t = setTimeout(() => update({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Back / forward (or a pasted link) changes the URL under the search box.
  useEffect(() => setQ(urlQ), [urlQ]);

  // Remembered so the Worklist link on a record page can return to this list.
  useEffect(() => rememberWorklist(params.toString()), [params]);

  const filters = { status: active.statuses?.join(','), mine: active.mine, q: urlQ || undefined };

  // The list is paged: the footer says how much of it is on screen, and "Show more"
  // fetches the rest. It used to fetch one page and say nothing, so with more than 50
  // records the older ones were simply unreachable except by searching for them.
  const list = useInfiniteQuery({
    queryKey: ['records', view, urlQ],
    queryFn: ({ pageParam }) => api.list({ ...filters, take: PAGE_SIZE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // FR-12.7 — statuses move on their own, so the list refreshes itself.
    refetchInterval: 4000,
  });

  // A record moving between pages mid-refresh can appear on two of them; show it once.
  const loaded = useMemo(() => {
    const seen = new Set<string>();
    const out: WorklistRow[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const row of page.rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          out.push(row);
        }
      }
    }
    return out;
  }, [list.data]);
  const matching = list.data ? list.data.pages[list.data.pages.length - 1]!.total : 0;

  const counts = useQuery({ queryKey: ['counts'], queryFn: api.counts, refetchInterval: 4000 });

  const upload = useMutation({
    mutationFn: (file: File) => api.upload(file),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['records'] });
      navigate(`/records/${res.record.id}`);
    },
    onError: (err) => setUploadError(err instanceof ApiError ? err.message : 'Upload failed.'),
  });

  // "/" puts the cursor in search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const total = counts.data ? Object.values(counts.data).reduce((a, b) => a + b, 0) : null;
  const countFor = (v: (typeof VIEWS)[number]) => {
    if (!counts.data) return null;
    if (v.key === 'all') return total;
    if (!v.statuses) return null;
    return v.statuses.reduce((sum, s) => sum + (counts.data![s] ?? 0), 0);
  };

  const sortRows = (input: WorklistRow[]) =>
    [...input].sort((a, b) => {
      const x = keyOf(a, sort.key);
      const y = keyOf(b, sort.key);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * sort.dir;
    });
  const rows = useMemo(() => sortRows(loaded), [loaded, sort]);

  const onSort = (key: SortKey) =>
    update({ sort: sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 } });

  // Approving from the list. Approvers only, and only in Needs review, where the question
  // "does this one need looking at?" is the whole point. The server decides what is ready and
  // checks again when it is asked to approve; this just shows its answer.
  const canBulk = (user?.role === 'APPROVER' || user?.role === 'ADMIN') && view === 'review';
  const reviewIds = useMemo(
    () => rows.filter((r) => r.status === 'NEEDS_REVIEW').map((r) => r.id).slice(0, READINESS_MAX),
    [rows],
  );
  const readiness = useQuery({
    queryKey: ['readiness', [...reviewIds].sort().join(',')],
    queryFn: () => api.readiness(reviewIds),
    enabled: canBulk && reviewIds.length > 0,
    refetchInterval: 15000,
    placeholderData: keepPreviousData,
  });
  const verdicts = readiness.data?.readiness;
  const ready = useMemo(() => readyIds(rows, verdicts), [rows, verdicts]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  // A record that stopped being ready since it was ticked (someone edited it, or sent it back) drops out.
  const chosen = ready.filter((id) => picked.has(id));
  const [confirming, setConfirming] = useState(false);
  const [bulkReport, setBulkReport] = useState<{ outcomes: BulkOutcome[]; labels: Record<string, string> } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  useEffect(() => {
    setPicked(new Set());
    setConfirming(false);
  }, [view, urlQ]);
  useEffect(() => {
    if (chosen.length === 0) setConfirming(false);
  }, [chosen.length]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allReadyPicked = ready.length > 0 && chosen.length === ready.length;

  const bulk = useMutation({
    mutationFn: (v: { ids: string[]; labels: Record<string, string> }) => api.bulkApprove(v.ids),
    onSuccess: (res, v) => {
      setBulkReport({ outcomes: res.outcomes, labels: v.labels });
      setPicked(new Set());
    },
    onError: (err) => setBulkError(err instanceof ApiError ? err.message : 'The batch could not be approved.'),
    onSettled: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
      qc.invalidateQueries({ queryKey: ['readiness'] });
    },
  });
  const approveChosen = () => {
    setBulkError(null);
    setBulkReport(null);
    const labels = Object.fromEntries(rows.map((r) => [r.id, r.header?.poNumber ?? r.correlationId]));
    bulk.mutate({ ids: chosen, labels });
  };

  const sortProps = (key: SortKey, label: string, cls?: string) => (
    <th
      className={`sortable ${cls ?? ''}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      onClick={() => onSort(key)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      <span className="dir" aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '·'}</span>
    </th>
  );

  const busy = upload.isPending || batch !== null;

  /**
   * One file opens its draft, so it can be checked before it is published. Several are each
   * made into their own record and sent straight for extraction (FR-1.7): checking a dozen
   * drafts one by one is the thing a batch is for avoiding, and anything that needs a
   * person's eye (a repeat of an earlier file, a failed publish) is left as a draft and
   * listed in the report.
   */
  const takeFiles = async (files: File[]) => {
    setUploadError(null);
    setReport(null);
    if (files.length === 0) return;
    if (busy) {
      setUploadError('An upload is still running. Add more when it has finished.');
      return;
    }
    if (files.length === 1) {
      const file = files[0]!;
      // Some sources drop files with an empty MIME type; the server validates the
      // actual content, so only refuse a file that positively claims to be something else.
      if (!isAcceptedFile(file)) {
        setUploadError(`${file.name}: ${NOT_ACCEPTED}`);
        return;
      }
      upload.mutate(file);
      return;
    }
    setBatch({ done: 0, total: files.length });
    try {
      setReport(
        await uploadAndPublishAll(files, api, { onProgress: (done, total) => setBatch({ done, total }) }),
      );
    } finally {
      setBatch(null);
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
    }
  };

  /**
   * FR-12.6 — export the current view, search and sort. "The current view" is every record
   * that matches, not just the pages loaded so far: exporting the visible 50 of 57 would
   * hand over a file that looks complete and is not.
   */
  const exportCsv = async () => {
    setExportError(null);
    setExporting(true);
    let all: WorklistRow[];
    try {
      all = [];
      for (;;) {
        const page = await api.list({ ...filters, take: 200, skip: all.length });
        all.push(...page.rows);
        if (!page.rows.length || all.length >= page.total) break;
      }
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'The export could not be fetched.');
      return;
    } finally {
      setExporting(false);
    }
    const esc = (v: string | null | undefined) => {
      const s = (v ?? '').replace(/\r?\n/g, ' ');
      return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      'Status,PO number,Customer,Customer code,Lines,Value,Currency,SO number,SO value,Uploaded by,File,Correlation id,Status changed',
      ...sortRows(all).map((r) =>
        [
          r.status,
          r.header?.poNumber,
          r.header?.customerName,
          r.header?.customerCode,
          String(r.header?._count.lineItems ?? 0),
          r.header?.poTotalValue,
          r.header?.currency,
          r.soNumber,
          r.salesOrder?.value,
          r.uploadedBy.name,
          r.sourceDocument?.originalFilename,
          r.correlationId,
          r.statusChangedAt,
        ]
          .map(esc)
          .join(','),
      ),
    ];
    // The BOM makes Excel read the file as UTF-8 instead of the local codepage.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `worklist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); void takeFiles(Array.from(e.dataTransfer.files ?? [])); }}
    >
      <div className="sheet">
        <div className="head">
          <div className="head-row">
            <div>
              <h1>Purchase orders</h1>
              <p className="cap">
                Drop PO PDFs, Excel sheets or Outlook emails anywhere on this page &mdash; up to {MAX_BATCH} at once &mdash; or press <kbd>/</kbd> to search.
                {mail.data?.enabled && !mailNeedsConnect && (
                  <> POs emailed to <b>{mail.data.mailbox}</b> are added automatically.</>
                )}
                {mailNeedsConnect && (
                  <> Outlook is not connected{canConnect ? '' : ' yet; an admin connects it'}.</>
                )}
              </p>
            </div>
            <div className="spacer" />
            <div className="actions">
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT_ATTR}
                multiple
                hidden
                // Copied out before the value is cleared: the FileList is live and empties with it.
                onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; void takeFiles(picked); }}
              />
              {mailNeedsConnect && canConnect && (
                <button
                  className="quiet sm"
                  onClick={() => connectOutlook.mutate()}
                  disabled={connectOutlook.isPending}
                  title={`Sign in once as ${mail.data?.mailbox || 'the intake mailbox'}, so emailed POs can be read`}
                >
                  {connectOutlook.isPending ? 'Opening Microsoft…' : 'Connect Outlook'}
                </button>
              )}
              {mail.data?.enabled && !mailNeedsConnect && user?.role !== 'APPROVER' && (
                <button
                  className="quiet sm"
                  onClick={() => checkMail.mutate()}
                  disabled={checkMail.isPending}
                  title={
                    mail.data.lastRunAt
                      ? `Last checked ${ago(mail.data.lastRunAt)} ago${mail.data.lastError ? ` (failed: ${mail.data.lastError})` : ''}. The mailbox is also checked every ${mail.data.pollSeconds} s.`
                      : `The mailbox is checked every ${mail.data.pollSeconds} s.`
                  }
                >
                  {checkMail.isPending ? 'Checking mail…' : 'Check mail'}
                </button>
              )}
              <button
                className="quiet sm"
                onClick={exportCsv}
                disabled={!rows.length || exporting}
                title="Download every record in the current view as CSV"
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
              <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                {batch ? `Uploading ${batch.done} of ${batch.total}…` : upload.isPending ? 'Uploading…' : 'Upload POs'}
              </button>
            </div>
          </div>
        </div>

        {uploadError && <div className="err" role="alert">{uploadError}</div>}
        {report && <BatchReport outcomes={report} onDismiss={() => setReport(null)} />}
        {exportError && <div className="err" role="alert">{exportError}</div>}
        {mailNote && <div className="err" role="alert">{mailNote}</div>}
        {connectNote && (
          <div className={connectNote.ok ? 'notice t-ok' : 'err'} role={connectNote.ok ? 'status' : 'alert'} onClick={() => setConnectNote(null)}>
            {connectNote.ok
              ? `Outlook connected as ${connectNote.detail}. POs emailed there are now picked up within a minute.`
              : `Outlook was not connected: ${connectNote.detail}`}
          </div>
        )}
        {bulkError && <div className="err" role="alert">{bulkError}</div>}
        {bulkReport && (
          <BulkReport outcomes={bulkReport.outcomes} labels={bulkReport.labels} onDismiss={() => setBulkReport(null)} />
        )}

        <div className="tabrule" role="group" aria-label="Filter by state">
          <div className="tabs">
            {VIEWS.map((v) => {
              const n = countFor(v);
              return (
                <button
                  key={v.key}
                  className={`tab ${v.tone}`}
                  aria-pressed={view === v.key}
                  onClick={() => update({ view: v.key })}
                >
                  {v.statuses && <span className="lamp" aria-hidden="true" />}
                  {v.label}
                  {n != null && <span className="n">{n}</span>}
                </button>
              );
            })}
          </div>
          <div className="spacer" />
          <div className="search">
            <span className="faint" aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="PO number, customer, SO number, correlation id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search records"
            />
          </div>
        </div>

        {canBulk && reviewIds.length > 0 && (
          <div className="bulkbar" role="region" aria-label="Approve together">
            {confirming ? (
              <>
                <span>
                  <b>
                    Approve {chosen.length} purchase order{chosen.length === 1 ? '' : 's'} and send{' '}
                    {chosen.length === 1 ? 'it' : 'them'} to SAP now?
                  </b>{' '}
                  Each one is checked again as it goes.
                </span>
                <span className="spacer" />
                <button className="primary" onClick={approveChosen} disabled={bulk.isPending}>
                  {bulk.isPending ? 'Approving…' : `Approve ${chosen.length}`}
                </button>
                <button className="quiet" onClick={() => setConfirming(false)} disabled={bulk.isPending}>Cancel</button>
              </>
            ) : (
              <>
                <span className="cap">
                  {!verdicts
                    ? 'Checking which can be approved together…'
                    : ready.length === 0
                      ? 'None of these can be approved together; each needs a look.'
                      : `${ready.length} of ${reviewIds.length} have nothing flagged and can be approved together.`}
                </span>
                <span className="spacer" />
                {ready.length > 0 && !allReadyPicked && (
                  <button className="quiet sm" onClick={() => setPicked(new Set(ready))}>Select all ready</button>
                )}
                {chosen.length > 0 && (
                  <>
                    <button className="quiet sm" onClick={() => setPicked(new Set())}>Clear</button>
                    <button className="primary" onClick={() => setConfirming(true)}>
                      Approve {chosen.length} selected
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {list.isLoading ? (
          <div className="empty">Loading…</div>
        ) : list.isError ? (
          <div className="err" role="alert">
            The worklist could not be loaded. It will retry on its own; check the health
            indicator above if this persists.
          </div>
        ) : !rows.length ? (
          <div className="empty">
            {q ? `Nothing matches “${q}”.` : 'Nothing here yet. Drop one or more POs (PDF, Excel or Outlook email) to get started.'}
          </div>
        ) : (
          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  {canBulk && (
                    <th className="pick">
                      <input
                        type="checkbox"
                        aria-label="Select all that are ready"
                        disabled={ready.length === 0}
                        checked={allReadyPicked}
                        ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && !allReadyPicked; }}
                        onChange={() => setPicked(allReadyPicked ? new Set() : new Set(ready))}
                      />
                    </th>
                  )}
                  {sortProps('status', 'State')}
                  {sortProps('poNumber', 'PO number')}
                  {sortProps('customer', 'Customer')}
                  {sortProps('lines', 'Lines', 'num')}
                  {sortProps('value', 'Value', 'num')}
                  {sortProps('soNumber', 'SO number')}
                  {sortProps('soValue', 'SO value', 'num')}
                  {canBulk && <th>Approve together?</th>}
                  <th>Uploaded by</th>
                  <th>Correlation id</th>
                  {sortProps('age', 'Age', 'num')}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const wants = r.status === 'NEEDS_REVIEW' || r.status === 'FAILED' || r.status === 'EXTRACTION_FAILED';
                  return (
                    <tr
                      key={r.id}
                      className={`${wants ? 'flagged' : ''} ${toneClass(statusTone(r.status))}`}
                      tabIndex={0}
                      onClick={() => navigate(`/records/${r.id}`)}
                      onKeyDown={(e) => {
                        // Space on the tick box ticks it; it is not a request to open the record.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/records/${r.id}`); }
                      }}
                    >
                      {canBulk && (
                        <td className="pick" onClick={(e) => e.stopPropagation()}>
                          {verdicts?.[r.id]?.clean && (
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.header?.poNumber ?? r.correlationId}`}
                              checked={picked.has(r.id)}
                              onChange={() => toggle(r.id)}
                            />
                          )}
                        </td>
                      )}
                      <td>
                        <StatusBadge status={r.status} />
                        {r.currentAttempt > 1 && <span className="sub mono">attempt {r.currentAttempt}</span>}
                      </td>
                      <td style={{ fontWeight: 500 }}>{r.header?.poNumber ?? <span className="faint">—</span>}</td>
                      <td>
                        {r.header?.customerName ?? <span className="faint">—</span>}
                        {r.header?.customerCode && <span className="sub mono">{r.header.customerCode}</span>}
                      </td>
                      <td className="num tnum">{r.header?._count.lineItems ?? 0}</td>
                      <td className="num tnum">
                        {r.header?.poTotalValue ? (
                          <>{r.header.poTotalValue} <span className="faint">{r.header.currency ?? ''}</span></>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="mono">{r.soNumber ?? <span className="faint">—</span>}</td>
                      <td className="num tnum">
                        {r.salesOrder ? (
                          <>{r.salesOrder.value} <span className="faint">{r.salesOrder.currency}</span></>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      {canBulk && (
                        <td>
                          {verdicts?.[r.id] ? (
                            verdicts[r.id]!.clean ? (
                              <span className="ready"><span aria-hidden="true">✓</span> Ready</span>
                            ) : (
                              <span className="held muted" title={verdicts[r.id]!.holds.map((h) => h.message).join('\n')}>
                                {holdSummary(verdicts[r.id]!)}
                              </span>
                            )
                          ) : (
                            <span className="faint">…</span>
                          )}
                        </td>
                      )}
                      <td className="muted">
                        {r.uploadedBy.name}
                        {r.intakeEmail && <span className="sub" title="Received by email from this sender">✉ {r.intakeEmail.fromAddress}</span>}
                      </td>
                      <td className="mono faint" title={r.correlationId}>{r.correlationId.slice(0, 11)}…</td>
                      <td className="num muted tnum">{ago(r.statusChangedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="cap" style={{ marginTop: 10 }}>
          {list.data &&
            (list.hasNextPage
              ? `Showing ${rows.length} of ${matching} records`
              : `${matching} record${matching === 1 ? '' : 's'}`)}
          {list.hasNextPage && (
            <>
              {' · '}
              <button
                className="quiet sm"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, matching - rows.length)} more`}
              </button>
              {(sort.key !== 'age' || sort.dir !== -1) && ' · sorted within the records shown'}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * What became of each record in an approve-together. The ones that went through are a count;
 * anything left behind is named with the reason and a way to open it.
 */
function BulkReport({
  outcomes, labels, onDismiss,
}: { outcomes: BulkOutcome[]; labels: Record<string, string>; onDismiss: () => void }) {
  const s = summariseBulk(outcomes);
  const parts = [
    s.approved > 0 && `${s.approved} approved and sent to SAP`,
    s.held > 0 && `${s.held} left for review`,
    s.failed > 0 && `${s.failed} could not be approved`,
  ].filter(Boolean);
  const left = outcomes.filter((o) => o.result !== 'approved');
  return (
    <div className={`notice ${left.length > 0 ? 't-warn' : 't-ok'}`} role="status" style={{ marginTop: 12 }}>
      <b>{parts.join(' · ')}</b>
      {s.approved > 0 && <span>SAP will report each Sales Order number back; they appear under SO created.</span>}
      {left.map((o) => (
        <span key={o.id}>
          <b>{labels[o.id] ?? o.id}</b> &mdash;{' '}
          {o.result === 'held' ? o.holds.map((h) => h.message).join('; ') : o.result === 'failed' ? o.message : ''}{' '}
          <Link to={`/records/${o.id}`}>Open</Link>
        </span>
      ))}
      <div>
        <button className="quiet sm" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

/**
 * What became of each file in a multi-file drop. The ones that went smoothly are a count;
 * anything that needs a person is named, with the reason and a way to open it.
 */
function BatchReport({ outcomes, onDismiss }: { outcomes: BatchOutcome[]; onDismiss: () => void }) {
  const s = summarise(outcomes);
  const attention = outcomes.filter((o) => o.kind !== 'queued');
  const parts = [
    s.queued > 0 && `${s.queued} sent for extraction`,
    s.draft > 0 && `${s.draft} left as ${s.draft === 1 ? 'a draft' : 'drafts'}`,
    s.skipped > 0 && `${s.skipped} skipped`,
    s.failed > 0 && `${s.failed} could not be uploaded`,
  ].filter(Boolean);
  return (
    <div className={`notice ${attention.length > 0 ? 't-warn' : 't-ok'}`} role="status" style={{ marginTop: 12 }}>
      <b>{outcomes.length} files: {parts.join(' · ')}</b>
      {s.queued > 0 && (
        <span>
          They are being read now, one after another, and will appear under Needs review as each finishes.
          Nothing goes to SAP until someone approves it.
        </span>
      )}
      {attention.map((o, i) => (
        <span key={`${o.file}-${i}`}>
          <b>{o.file}</b> &mdash; {o.kind === 'draft' || o.kind === 'skipped' || o.kind === 'failed' ? o.reason : ''}
          {o.kind === 'draft' && (
            <>
              {' '}
              <Link to={`/records/${o.recordId}`}>Open</Link>
            </>
          )}
        </span>
      ))}
      <div>
        <button className="quiet sm" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
