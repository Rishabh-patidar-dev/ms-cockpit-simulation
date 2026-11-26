import { GoogleGenAI, ThinkingLevel, Type, type Schema, type ThinkingConfig } from '@google/genai';
import { env } from '../../config/env.js';
import { HEADER_FIELDS, LINE_FIELDS, extractionResultSchema } from '../../domain/types.js';
import { childLogger } from '../../lib/logger.js';
import { ExtractionError, type ExtractionProvider, type ExtractionRequest, type ExtractionResponse } from './types.js';

/**
 * FR-4.7 — the model is asked for a structured response conforming to this schema, not
 * for free text. FR-4.8 — every field carries its own confidence.
 */
const confidentValueSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    value: { type: Type.STRING, nullable: true, description: 'Verbatim value from the document, or null if absent.' },
    confidence: { type: Type.NUMBER, description: 'Certainty that this value was read correctly, 0.0 to 1.0.' },
  },
  required: ['value', 'confidence'],
};

const objectOf = (fields: readonly string[], extra: Record<string, Schema> = {}): Schema => ({
  type: Type.OBJECT,
  properties: {
    ...extra,
    ...Object.fromEntries(fields.map((f) => [f, confidentValueSchema])),
  },
  required: [...Object.keys(extra), ...fields],
});

export const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    header: objectOf(HEADER_FIELDS),
    lineItems: {
      type: Type.ARRAY,
      items: objectOf(LINE_FIELDS, {
        lineNumber: { type: Type.INTEGER, description: 'Sequential line number starting at 1.' },
      }),
    },
    vendorIdentified: { type: Type.STRING, nullable: true },
  },
  required: ['header', 'lineItems'],
};

const log = childLogger('gemini');

/** Transient conditions worth a retry; anything else fails the attempt outright. */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('rate limit')
  );
}

/** Gemini's own "try again later": overloaded (503) or over quota (429). Neither is billed. */
export function isOverloaded(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 503 || status === 429) return true;
  const msg = String((err as Error)?.message ?? '');
  return /"code":\s*(503|429)|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(msg);
}

/**
 * The key's daily allowance for this model is spent (the free tier gives 20 requests a day).
 * Waiting minutes cannot help; another model, which has its own allowance, might.
 */
export const isDailyQuotaSpent = (err: unknown) => /per day|PerDay/i.test(String((err as Error)?.message ?? ''));

/** The model is not offered to this key (retired, or not yet enabled). */
const isModelMissing = (err: unknown) =>
  (err as { status?: number })?.status === 404 || /"code":\s*404|NOT_FOUND/.test(String((err as Error)?.message ?? ''));

/** Seconds waited before each retry of an overloaded call: 10, 20, 40, 60, 60, ... */
export const overloadWaitMs = (retry: number) => Math.min(60_000, 10_000 * 2 ** (retry - 1));

/** The longest an extraction can spend waiting out overload, for the worker's stuck-record rule. */
export const maxOverloadWaitMs = () =>
  Array.from({ length: env.EXTRACTION_OVERLOAD_RETRIES }, (_, i) => overloadWaitMs(i + 1) + 30_000).reduce((a, b) => a + b, 0);

/**
 * How hard the model should think. A spreadsheet arrives as typed values, so there is
 * nothing to decipher and long reasoning only costs time (it pushed a 30-row sheet past
 * the time limit). Gemini 3 takes a level; Gemini 2.5 takes a token budget.
 */
export function thinkingFor(model: string, isSpreadsheet: boolean): ThinkingConfig | undefined {
  if (!isSpreadsheet) return undefined;
  return /^gemini-2\./.test(model) ? { thinkingBudget: 512 } : { thinkingLevel: ThinkingLevel.LOW };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GEMINI_API_KEYS (comma, space or newline separated), then GEMINI_API_KEY, without repeats. */
export function configuredKeys(list: string = env.GEMINI_API_KEYS, single: string = env.GEMINI_API_KEY): string[] {
  return [...new Set([...list.split(/[\s,;]+/), single].map((k) => k.trim()).filter(Boolean))];
}

/**
 * A fault of the key rather than of the request or of Gemini's load: expired, invalid, not
 * allowed, or out of quota (per minute or per day). With several keys the next one is used at
 * once; with one, the error is handled as before (a quota error is waited out).
 */
export function isKeyProblem(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const msg = String((err as Error)?.message ?? '');
  if (status === 401 || status === 403 || status === 429) return true;
  return /API[_ ]key (expired|not valid|invalid)|API_KEY_INVALID|API_KEY_EXPIRED|PERMISSION_DENIED|UNAUTHENTICATED|CONSUMER_SUSPENDED|RESOURCE_EXHAUSTED|exceeded your current quota|"code":\s*(401|403|429)/i.test(msg);
}

/** How long a key is passed over after it failed: an hour when spent for the day, a minute when rate-limited, hours when broken. */
function restFor(err: unknown): number {
  if (isDailyQuotaSpent(err)) return 3_600_000;
  const rateLimited = (err as { status?: number })?.status === 429 || /RESOURCE_EXHAUSTED|quota|"code":\s*429/i.test(String((err as Error)?.message ?? ''));
  return rateLimited ? 60_000 : 6 * 3_600_000;
}

/**
 * A confidence outside 0–1 fails the whole answer, and on a 36-page PO one field in 3,000
 * came back as 100 (a percentage). Read 1–100 as a percentage and clamp the rest, rather
 * than throw away every other value. Only `confidence` numbers are touched.
 */
export function normaliseConfidences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseConfidences);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (k === 'confidence' && typeof v === 'number' && Number.isFinite(v)) {
        const c = v > 1 && v <= 100 ? v / 100 : v;
        return [k, Math.min(1, Math.max(0, c))];
      }
      return [k, normaliseConfidences(v)];
    }),
  );
}

export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = 'gemini';
  private readonly clients: GoogleGenAI[];
  /** Until when (epoch ms) each key is passed over. */
  private readonly restingUntil: number[];
  private current = 0;

  constructor(apiKeys: string | string[] = configuredKeys()) {
    const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
    if (keys.length === 0) {
      throw new Error(
        'No Gemini API key is set. Set GEMINI_API_KEYS (or GEMINI_API_KEY) in backend/.env, or set EXTRACTION_PROVIDER=mock to run without it.',
      );
    }
    this.clients = keys.map((apiKey) => new GoogleGenAI({ apiKey }));
    this.restingUntil = keys.map(() => 0);
  }

  private get client(): GoogleGenAI {
    return this.clients[this.current]!;
  }

  /**
   * After a key problem: rest this key and move to the next one that is not resting. False
   * when there is no other key to try, so the caller handles the error as with a single key.
   */
  private nextKey(err: unknown): boolean {
    if (this.clients.length < 2) return false;
    this.restingUntil[this.current] = Date.now() + restFor(err);
    const now = Date.now();
    for (let step = 1; step < this.clients.length; step++) {
      const i = (this.current + step) % this.clients.length;
      if (this.restingUntil[i]! <= now) {
        log.warn({ from: this.current + 1, to: i + 1 }, 'Gemini key failed (expired, invalid or out of quota); using the next key');
        this.current = i;
        return true;
      }
    }
    return false;
  }

  /**
   * One extraction. An overloaded or rate-limited answer is waited out and tried again,
   * alternating with GEMINI_FALLBACK_MODEL, before it counts as a failed attempt. A fallback
   * model this key cannot use is dropped rather than failing the record.
   */
  async extract(req: ExtractionRequest, sleep: (ms: number) => Promise<void> = wait): Promise<ExtractionResponse> {
    const allModels = () => [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter((m, i, all) => m && all.indexOf(m) === i);
    let models = allModels();
    let lastErr: unknown;
    for (let retry = 0; retry <= env.EXTRACTION_OVERLOAD_RETRIES; retry++) {
      const model = models[retry % models.length]!;
      try {
        return await this.extractWith(model, req);
      } catch (err) {
        const cause = err instanceof ExtractionError ? err.cause : err;
        // A spent, expired or rate-limited key: the next key gets the same request at once,
        // with both models again, and it does not count as one of the waits.
        if (isKeyProblem(cause) && this.nextKey(cause)) {
          models = allModels();
          retry--;
          continue;
        }
        if (model !== env.GEMINI_MODEL && isModelMissing(cause)) {
          models.splice(models.indexOf(model), 1);
          continue;
        }
        lastErr = err;
        if (!isOverloaded(cause) || retry === env.EXTRACTION_OVERLOAD_RETRIES) throw err;
        if (isDailyQuotaSpent(cause)) {
          // This model is done for the day: carry on with the others, without waiting.
          models.splice(models.indexOf(model), 1);
          if (models.length === 0) {
            throw new ExtractionError(
              `The Gemini key${this.clients.length > 1 ? 's have' : ' has'} used ${this.clients.length > 1 ? 'their' : 'its'} daily allowance for every model it is set to use (${[env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter(Boolean).join(', ')}). The free tier allows 20 requests a day per model; retry tomorrow, or enable billing on the key's Google AI Studio project.`,
              false,
              cause,
            );
          }
          retry--;
          continue;
        }
        await sleep(overloadWaitMs(retry + 1));
      }
    }
    throw lastErr;
  }

  private async extractWith(model: string, req: ExtractionRequest): Promise<ExtractionResponse> {
    const started = Date.now();
    const controller = new AbortController();
    // FR-4.10 — bound the call; a hung request must not hold a record in PROCESSING.
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);

    let response;
    try {
      response = await this.client.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              req.sheetText !== undefined
                ? { text: `The purchase order below is a spreadsheet, given cell by cell.\n\n${req.sheetText}` }
                : { inlineData: { mimeType: 'application/pdf', data: req.document.toString('base64') } },
              { text: req.prompt },
            ],
          },
        ],
        config: {
          abortSignal: controller.signal,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // Extraction is a reading task, not a creative one.
          temperature: 0,
          thinkingConfig: thinkingFor(model, req.sheetText !== undefined),
        },
      });
    } catch (err) {
      throw new ExtractionError(
        `Gemini request failed: ${(err as Error).message}`,
        isRetryable(err),
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    const text = response.text;
    if (!text) {
      throw new ExtractionError('Gemini returned an empty response.', true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // FR-4.13 — malformed output is a failed attempt, never reviewable data.
      throw new ExtractionError('Gemini returned a response that was not valid JSON.', true);
    }

    const validated = extractionResultSchema.safeParse(normaliseConfidences(parsed));
    if (!validated.success) {
      throw new ExtractionError(
        `Gemini response did not match the extraction schema: ${validated.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        true,
        validated.error,
      );
    }

    return {
      result: validated.data,
      raw: parsed,
      model,
      provider: this.name,
      latencyMs,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}
