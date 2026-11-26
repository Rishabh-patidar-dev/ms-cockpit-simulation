/**
 * Runs the real extractor on files on disk, without the database or the app: a way to see
 * what Gemini reads from a customer's PO (PDF, Excel, CSV, or an Outlook .msg carrying them)
 * before uploading it. The same prompt and spreadsheet handling as the extraction worker.
 *
 *   npx tsx scripts/extractFiles.ts <out-dir> <file> [file ...]
 *
 * Writes <out-dir>/<name>.json per PO and prints a one-line summary each. Uses
 * GEMINI_API_KEYS / GEMINI_API_KEY and GEMINI_MODEL from backend/.env.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { cleanExtraction } from '../src/domain/cleanExtraction.js';
import { detectDocumentKind, isSpreadsheet, unsupportedReason, type DocumentKind } from '../src/services/documentKind.js';
import { GeminiExtractionProvider } from '../src/services/extraction/gemini.js';
import { extractByPages } from '../src/services/extraction/pages.js';
import { countPdfPages } from '../src/services/storage.js';
import { GENERIC_EXTRACTION_PROMPT, SPREADSHEET_NOTES } from '../src/services/extraction/prompts.js';
import { isOutlookMessage, noPoReason, openEmail } from '../src/services/outlookUpload.js';
import { readSpreadsheet, workbookToText } from '../src/services/spreadsheet.js';

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || files.length === 0) {
  console.error('usage: tsx scripts/extractFiles.ts <out-dir> <file> [file ...]');
  process.exit(2);
}
await fs.mkdir(outDir, { recursive: true });
const provider = new GeminiExtractionProvider();
const v = (c: { value: string | null } | undefined) => c?.value ?? '—';

// Each file, or each PO attached to an email, is one job.
const jobs: { label: string; name: string; content: Buffer; kind: DocumentKind }[] = [];
let failed = 0;
for (const file of files) {
  const name = path.basename(file);
  const content = await fs.readFile(file);
  if (isOutlookMessage(content)) {
    const opened = openEmail(content);
    if (opened.pos.length === 0) {
      failed++;
      console.log(`FAIL ${name}\n     ${noPoReason(name, opened)}`);
    }
    for (const po of opened.pos) jobs.push({ label: `${name} › ${po.name}`, name: po.name, content: po.content, kind: po.kind });
    continue;
  }
  const kind = detectDocumentKind(content, name);
  if (!kind) {
    failed++;
    console.log(`FAIL ${name}\n     ${unsupportedReason(content, name)}`);
    continue;
  }
  jobs.push({ label: name, name, content, kind });
}

for (const job of jobs) {
  try {
    const sheetText = isSpreadsheet(job.kind) ? workbookToText(await readSpreadsheet(job.content, job.kind, job.name)) : undefined;
    // As the worker does: a long PDF is read a few pages per request.
    const res = await extractByPages(
      provider,
      {
        document: job.content,
        sheetText,
        prompt: sheetText !== undefined ? `${GENERIC_EXTRACTION_PROMPT}\n\n---\n${SPREADSHEET_NOTES}` : GENERIC_EXTRACTION_PROMPT,
        promptVersion: 'script',
        timeoutMs: env.EXTRACTION_TIMEOUT_MS,
      },
      job.kind === 'pdf' ? countPdfPages(job.content) : null,
      env.EXTRACTION_PAGES_PER_CALL,
      env.EXTRACTION_ROWS_PER_CALL,
    );
    const result = cleanExtraction(res.result);
    const out = path.join(outDir, `${job.label.replace(/[^\w.-]+/g, '_')}.json`);
    await fs.writeFile(out, JSON.stringify({ file: job.label, model: res.model, latencyMs: res.latencyMs, result }, null, 2));
    const h = result.header;
    console.log(
      `OK   ${job.label}\n     PO ${v(h.poNumber)} · ${v(h.poDate)} · ${v(h.customerName)} · ${v(h.currency)} · total ${v(h.poTotalValue)} · ${result.lineItems.length} line(s) · ${res.model} ${(res.latencyMs / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    failed++;
    console.log(`FAIL ${job.label}\n     ${(err as Error).message.slice(0, 300)}`);
  }
}
process.exit(failed ? 1 : 0);
