import type { AiInput, AiProvider } from '../../src/server/ai/provider.js';

export interface FakeOpts {
  delayMs?: number;
  /** Return the raw model output for call number n (1-based), or throw. */
  respond?: (n: number, input: AiInput) => unknown;
}

export function validOutput(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: `Hook ${n}`, description: `Desc ${n}`, hashtags: ['#Clutch'], confidence: 'high', needsReview: false, ...over };
}

export class FakeProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  calls = 0;
  active = 0;
  maxActive = 0;
  inputs: AiInput[] = [];

  constructor(private readonly opts: FakeOpts = {}) {}

  async generate(input: AiInput): Promise<unknown> {
    const n = ++this.calls;
    this.inputs.push(input);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
      return this.opts.respond ? this.opts.respond(n, input) : validOutput(n);
    } finally {
      this.active--;
    }
  }
}
