import { AiError, type AiInput, type AiProvider } from './provider.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface ErrorDetail {
  '@type'?: string;
  retryDelay?: string;
  violations?: { quotaId?: string }[];
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; details?: ErrorDetail[] };
}

/** Reads the quota scope (per minute or per day) and the suggested wait from Google's error details. */
function quotaInfo(details: ErrorDetail[] | undefined): { quotaScope?: 'minute' | 'day'; retryAfterMs?: number } {
  const out: { quotaScope?: 'minute' | 'day'; retryAfterMs?: number } = {};
  for (const d of details ?? []) {
    for (const v of d.violations ?? []) {
      if (/PerDay/i.test(v.quotaId ?? '')) out.quotaScope = 'day';
      else if (/PerMinute/i.test(v.quotaId ?? '') && out.quotaScope !== 'day') out.quotaScope = 'minute';
    }
    const m = d.retryDelay?.match(/^([\d.]+)s$/);
    if (m) out.retryAfterMs = Math.round(parseFloat(m[1]) * 1000);
  }
  return out;
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    opts: { baseUrl?: string; timeoutMs?: number } = {},
  ) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }
  private readonly timeoutMs: number;

  private scrub(text: string): string {
    return text.split(this.apiKey).join('[key]').slice(0, 200);
  }

  async generate(input: AiInput): Promise<unknown> {
    const body = {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.userText },
            ...input.frames.map((f) => ({ inlineData: { mimeType: 'image/jpeg', data: f.toString('base64') } })),
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
    };

    let res: Response;
    try {
      res = await fetch(`${this.base}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new AiError(`Gemini request failed: ${this.scrub(e instanceof Error ? e.message : String(e))}`, true);
    }

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      let info: { quotaScope?: 'minute' | 'day'; retryAfterMs?: number } = {};
      try {
        const err = (JSON.parse(text) as GeminiResponse).error;
        detail = err?.message ?? text;
        if (res.status === 429) info = quotaInfo(err?.details);
      } catch {
        /* keep raw text */
      }
      // A per-day quota will not clear by retrying today.
      const retryable = (res.status === 408 || res.status === 429 || res.status >= 500) && info.quotaScope !== 'day';
      throw new AiError(`Gemini returned ${res.status}: ${this.scrub(detail)}`, retryable, res.status, info);
    }

    let json: GeminiResponse;
    try {
      json = JSON.parse(text) as GeminiResponse;
    } catch {
      throw new AiError('Gemini returned a non-JSON response', true);
    }
    if (json.promptFeedback?.blockReason) throw new AiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`, false);
    const cand = json.candidates?.[0];
    if (cand?.finishReason && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(cand.finishReason)) {
      throw new AiError(`Gemini blocked the response: ${cand.finishReason}`, false);
    }
    const out = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!out) throw new AiError('Gemini returned an empty response', true);
    try {
      return JSON.parse(out);
    } catch {
      return out; // let validation reject it
    }
  }
}
