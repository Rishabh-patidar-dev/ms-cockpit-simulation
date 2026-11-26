import { readZip } from './zip.js';

/**
 * An .xlsx workbook read into plain rows of text, so a spreadsheet PO or delivery schedule
 * can be given to the extractor (which reads text, not Excel). Values are taken as Excel
 * stores them (the cached result of a formula, not the formula), and dates stay as Excel's
 * serial numbers unless the cell holds text — the extractor is told so.
 */
export interface Sheet {
  name: string;
  hidden: boolean;
  rows: string[][];
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]!) : undefined;
};

/** The text of every <t> run inside a shared-string or inline-string item, joined. */
const runsText = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join('');

/** "AB12" → column index 27 (0-based). */
function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(buffer: Buffer): Sheet[] {
  const files = readZip(buffer);
  const text = (name: string) => files.get(name)?.toString('utf8');

  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook (xl/workbook.xml missing).');

  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1]!));

  // Sheet name → file, through the workbook's relationships.
  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id');
    const path = rid ? rels.get(rid) : undefined;
    const xml = path ? text(path) : undefined;
    if (!xml) continue;

    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      // Excel leaves empty rows out; keep row numbers true to the sheet.
      const rowNumber = Number(attr(`<row${row[1]}>`, 'r') ?? rows.length + 1);
      while (rows.length < rowNumber - 1) rows.push([]);
      const cells: string[] = [];
      for (const c of row[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = `<c${c[1]}>`;
        const ref = attr(head, 'r');
        const type = attr(head, 't');
        const body = c[2] ?? '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = runsText(body);
        else if (type === 'b' && v !== undefined) value = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' && v !== undefined) value = decodeXml(v);
        // A number as Excel stores it carries float noise (0.29930000000000001); print it as JS would.
        else if (v !== undefined) value = /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v) ? String(Number(v)) : decodeXml(v);
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = value.replace(/\s+/g, ' ').trim();
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells);
    }
    // Trailing empty rows say nothing.
    while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
    sheets.push({ name, hidden: /state="(hidden|veryHidden)"/.test(m[0]), rows });
  }
  return sheets;
}

/**
 * Sheets as text a model reads reliably: one line per row, cells separated by " | ", each
 * row prefixed with its spreadsheet row number so a value can be traced back. Empty rows
 * are dropped; hidden sheets are labelled as hidden.
 */
export function sheetsToText(sheets: Sheet[]): string {
  return sheets
    .map((s) => {
      const lines = s.rows
        .map((r, i) => (r.some((c) => c !== '') ? `R${i + 1}: ${r.join(' | ')}` : null))
        .filter((l): l is string => l !== null);
      return `### Sheet "${s.name}"${s.hidden ? ' (hidden)' : ''}\n${lines.length ? lines.join('\n') : '(empty)'}`;
    })
    .join('\n\n');
}
