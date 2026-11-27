export interface AiInput {
  systemPrompt: string;
  userText: string;
  /** JPEG frames, in time order. */
  frames: Buffer[];
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Returns the parsed JSON, or the raw text if the model did not return JSON. */
  generate(input: AiInput): Promise<unknown>;
}

export interface AiErrorExtra {
  /** 'day' means retrying today is pointless; 'minute' clears quickly. */
  quotaScope?: 'minute' | 'day';
  /** How long the provider asked us to wait. */
  retryAfterMs?: number;
}

export class AiError extends Error {
  readonly quotaScope?: 'minute' | 'day';
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    extra: AiErrorExtra = {},
  ) {
    super(message);
    this.name = 'AiError';
    this.quotaScope = extra.quotaScope;
    this.retryAfterMs = extra.retryAfterMs;
  }
}
