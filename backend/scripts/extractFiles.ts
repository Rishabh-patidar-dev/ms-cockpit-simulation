/**
 * Runs the real extractor on files on disk, without the database or the app: a way to see
 * what Gemini reads from a customer's PO (PDF, Excel, CSV, Outlook .msg) before uploading it.
 *
 *   npx tsx scripts/extractFiles.ts <out-dir> <file> [file ...]
 *
 * Writes <out-dir>/<file>.json with the cleaned result and prints a one-line summary per
 * file. Uses GEMINI_API_KEYS / GEMINI_API_KEY and GEMINI_MODEL from backend/.env.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { cleanExtraction } from '../src/domain/cleanExtraction.js';
import { GeminiExtractionProvider } from '../src/services/extraction/gemini.js';
import { GENERIC_EXTRACTION_PROMPT, GENERIC_PROMPT_VERSION } from '../src/services/extraction/prompts.js';

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || files.length === 0) {
  console.error('usage: tsx scripts/extractFiles.ts <out-dir> <file> [file ...]');
  process.exit(2);
}
await fs.mkdir(outDir, { recursive: true });
const provider = new GeminiExtractionProvider();

const v = (c: { value: string | null } | undefined) => c?.value ?? '—';

let failed = 0;
for (const file of files) {
  const name = path.basename(file);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= env.EXTRACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await provider.extract({
        document: await fs.readFile(file),
        filename: name,
        prompt: GENERIC_EXTRACTION_PROMPT,
        promptVersion: GENERIC_PROMPT_VERSION,
        timeoutMs: Math.max(env.EXTRACTION_TIMEOUT_MS, 300_000),
      });
      const result = cleanExtraction(res.result);
      await fs.writeFile(path.join(outDir, `${name}.json`), JSON.stringify({ file: name, model: res.model, latencyMs: res.latencyMs, result }, null, 2));
      const h = result.header;
      console.log(
        `OK   ${name}\n     PO ${v(h.poNumber)} · ${v(h.poDate)} · ${v(h.customerName)} · ${v(h.currency)} · total ${v(h.poTotalValue)} · ${result.lineItems.length} line(s) · ${(res.latencyMs / 1000).toFixed(1)}s`,
      );
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const retryable = (err as { retryable?: boolean }).retryable;
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (lastErr) {
    failed++;
    console.log(`FAIL ${name}\n     ${(lastErr as Error).message.slice(0, 300)}`);
  }
}
process.exit(failed ? 1 : 0);
