const URL_RE = /(https?:\/\/|www\.)\S+/i;
const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|gg|ly|tv|me|co|xyz|link|ru|cn|top|info|biz|app|shop|site|online|club|vip|ws|cc|to|tk|ml|ga|cf|gq)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const INSTRUCTION_RE =
  /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)|system prompt|as an ai( language)? model|you are now|new instructions?/i;

/**
 * Deterministic checks on generated text. The model's own confidence is untrusted (text in a
 * frame or filename can talk it into "high"), so anything that looks like a link, an email, or
 * echoed instructions is forced into manual review instead of auto-publishing.
 */
export function reviewReasons(m: { title: string; description: string; hashtags: string[] }): string[] {
  const text = [m.title, m.description, ...m.hashtags].join('\n');
  const reasons: string[] = [];
  if (URL_RE.test(text) || DOMAIN_RE.test(text)) reasons.push('contains a link or web address');
  if (EMAIL_RE.test(text)) reasons.push('contains an email address');
  if (INSTRUCTION_RE.test(text)) reasons.push('contains text that looks like instructions to an AI');
  return reasons;
}
