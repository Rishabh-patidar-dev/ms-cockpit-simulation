import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { env } from '../../config/env.js';
import { HEADER_FIELDS, LINE_FIELDS, extractionResultSchema } from '../../domain/types.js';
import { childLogger } from '../../lib/logger.js';
import { extractionParts } from '../documents/index.js';
import { ExtractionError, type ExtractionProvider, type ExtractionRequest, type ExtractionResponse } from './types.js';

/**
 * FR-4.7 — the model is asked for a structured response conforming to this schema, not
 * for free text. FR-4.8 — every field carries its own confidence.
 */
const log = childLogger('gemini');

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

/**
 * Why a key, rather than the request, failed: such an error moves on to the next key at
 * once instead of spending one of the record's retries. Invalid and expired keys are put
 * aside for hours; a key out of quota or rate-limited for a minute (a daily quota trips
 * again on the next try and is put aside again).
 */
export function keyFailure(err: unknown): { reason: string; cooldownMs: number } | null {
  const status = (err as { status?: number })?.status;
  const msg = String((err as Error)?.message ?? '');
  if (/API[_ ]key (expired|not valid|invalid)|API_KEY_INVALID|API_KEY_EXPIRED|key.*(revoked|suspended)|CONSUMER_SUSPENDED/i.test(msg)) {
    return { reason: 'invalid or expired', cooldownMs: 6 * 60 * 60_000 };
  }
  if (status === 401 || status === 403 || /PERMISSION_DENIED|UNAUTHENTICATED/.test(msg)) {
    return { reason: 'not authorised', cooldownMs: 6 * 60 * 60_000 };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return { reason: 'out of quota or rate-limited', cooldownMs: 60_000 };
  }
  return null;
}

/** GEMINI_API_KEYS (comma, space or newline separated) and GEMINI_API_KEY, in that order, without repeats. */
export function configuredKeys(list: string = env.GEMINI_API_KEYS, single: string = env.GEMINI_API_KEY): string[] {
  return [...new Set([...list.split(/[\s,;]+/), single].map((k) => k.trim()).filter(Boolean))];
}

interface PooledKey {
  /** Position in the configured list, 1-based; logged instead of the key itself. */
  n: number;
  client: GoogleGenAI;
  resting: number; // epoch ms until which the key is not used
}

export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = 'gemini';
  private readonly keys: PooledKey[];
  private current = 0;

  constructor(apiKeys: string[] = configuredKeys()) {
    if (apiKeys.length === 0) {
      throw new Error(
        'No Gemini API key is set. Set GEMINI_API_KEYS (or GEMINI_API_KEY) in backend/.env, or set EXTRACTION_PROVIDER=mock to run without it.',
      );
    }
    this.keys = apiKeys.map((apiKey, i) => ({ n: i + 1, client: new GoogleGenAI({ apiKey }), resting: 0 }));
  }

  /** The keys to try for one request: the current one first, then the rest; resting keys only if nothing else is left. */
  private order(): PooledKey[] {
    const now = Date.now();
    const rotated = [...this.keys.slice(this.current), ...this.keys.slice(0, this.current)];
    const ready = rotated.filter((k) => k.resting <= now);
    return ready.length ? ready : [...rotated].sort((a, b) => a.resting - b.resting).slice(0, 1);
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResponse> {
    const started = Date.now();
    const controller = new AbortController();
    // FR-4.10 — bound the call; a hung request must not hold a record in PROCESSING.
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);

    let parts;
    try {
      parts = extractionParts(req.document, req.filename);
    } catch (err) {
      clearTimeout(timer);
      throw new ExtractionError(`The document could not be read: ${(err as Error).message}`, false, err);
    }

    let response;
    const keyErrors: string[] = [];
    try {
      for (const key of this.order()) {
        try {
          response = await key.client.models.generateContent({
            model: env.GEMINI_MODEL,
            contents: [{ role: 'user', parts: [...parts, { text: req.prompt }] }],
            config: {
              abortSignal: controller.signal,
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
              // Extraction is a reading task, not a creative one.
              temperature: 0,
            },
          });
          this.current = key.n - 1;
          break;
        } catch (err) {
          const failure = keyFailure(err);
          if (!failure) throw err;
          key.resting = Date.now() + failure.cooldownMs;
          keyErrors.push(`key ${key.n} ${failure.reason}`);
          log.warn({ key: key.n, reason: failure.reason }, 'Gemini key failed; trying the next one');
        }
      }
    } catch (err) {
      throw new ExtractionError(
        `Gemini request failed: ${(err as Error).message}`,
        isRetryable(err),
        err,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response) {
      // Every key failed for a key reason. Quota comes back on its own, so that is worth a retry.
      throw new ExtractionError(
        `Every Gemini API key failed (${keyErrors.join('; ')}). Add a working key to GEMINI_API_KEYS.`,
        keyErrors.some((e) => e.includes('quota')),
      );
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

    const validated = extractionResultSchema.safeParse(parsed);
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
      model: env.GEMINI_MODEL,
      provider: this.name,
      latencyMs,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}
