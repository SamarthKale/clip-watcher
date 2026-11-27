import { z } from 'zod';
import { DESCRIPTION_MAX_BYTES, HASHTAGS_MAX, TITLE_MAX_CHARS } from './limits.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const HASHTAG = /^#[\p{L}\p{N}_]+$/u;

const Title = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .refine((s) => s.length > 0, 'title is empty')
      .refine((s) => Array.from(s).length <= TITLE_MAX_CHARS, `title is longer than ${TITLE_MAX_CHARS} characters`)
      .refine((s) => !CONTROL.test(s), 'title contains control characters or line breaks')
      .refine((s) => !/[<>]/.test(s), 'title contains < or >'),
  );

const Description = z
  .string()
  .transform((s) => s.replace(/\r\n/g, '\n').replace(CONTROL_EXCEPT_NEWLINE_TAB, '').replace(/[<>]/g, '').trim())
  .pipe(z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= DESCRIPTION_MAX_BYTES, `description is longer than ${DESCRIPTION_MAX_BYTES} bytes`));

export const MetadataSchema = z.object({
  title: Title,
  description: Description,
  hashtags: z.array(z.string().regex(HASHTAG, 'hashtag must start with # and contain no spaces')),
  categoryId: z.string().optional(),
  language: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  needsReview: z.boolean(),
});
export type Metadata = z.infer<typeof MetadataSchema>;

export type ValidationResult = { ok: true; value: Metadata } | { ok: false; errors: string[] };

/** Validates model (or user) output. Nothing reaches the upload queue without passing this. */
export function validateMetadata(raw: unknown, opts: { fixedHashtags?: string[] } = {}): ValidationResult {
  if (typeof raw === 'string') return { ok: false, errors: ['model output was not a valid JSON object'] };
  const parsed = MetadataSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`) };
  }
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const h of [...(opts.fixedHashtags ?? []).filter((x) => HASHTAG.test(x)), ...parsed.data.hashtags]) {
    const k = h.toLowerCase();
    if (!seen.has(k) && hashtags.length < HASHTAGS_MAX) {
      seen.add(k);
      hashtags.push(h);
    }
  }
  return { ok: true, value: { ...parsed.data, hashtags } };
}
