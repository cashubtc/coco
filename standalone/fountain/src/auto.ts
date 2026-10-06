import { FountainDecoder } from './core.js';
import { UrDecoder } from './ur.js';

export type DecoderFormat = 'binary' | 'ur';

/** Routes scanned bytes or UR text to one format-specific decoder per transfer. */
export class AutoDecoder {
  #decoder: FountainDecoder | UrDecoder | undefined;
  #format: DecoderFormat | undefined;

  get format(): DecoderFormat | undefined {
    return this.#format;
  }
  get isComplete(): boolean {
    return this.#decoder?.isComplete ?? false;
  }
  get result(): Uint8Array | undefined {
    return this.#decoder?.result;
  }
  get independentFrames(): number {
    return this.#decoder?.independentFrames ?? 0;
  }
  get fragmentCount(): number | undefined {
    return this.#decoder?.fragmentCount;
  }
  get progress(): number {
    return this.#decoder?.progress ?? 0;
  }

  reset(): void {
    this.#decoder = undefined;
    this.#format = undefined;
  }

  /**
   * Selects a format on its first accepted frame and delegates receive semantics.
   * Unknown prefixes return false. Switching formats requires reset(). Binary
   * validation errors and invalid UTF-8 in UR bytes throw; invalid UR text returns
   * false. The boolean is acceptance, not completion or guaranteed progress.
   */
  receive(input: Uint8Array | string): boolean {
    let format: DecoderFormat | undefined;
    if (typeof input === 'string') {
      if (/^ur:/i.test(input)) format = 'ur';
    } else if (input instanceof Uint8Array) {
      if (
        (input[0] === 0x75 || input[0] === 0x55) &&
        (input[1] === 0x72 || input[1] === 0x52) &&
        input[2] === 0x3a
      )
        format = 'ur';
      else if (input[0] === 0x4e && input[1] === 0x46) format = 'binary';
    } else {
      throw new TypeError('Expected scanned bytes or UR text');
    }
    if (!format) return false;
    if (this.#format && this.#format !== format) {
      throw new Error('Frame belongs to another message format; reset the decoder first');
    }
    const decoder = this.#decoder ?? (format === 'ur' ? new UrDecoder() : new FountainDecoder());
    // Only UR is text. Binary frames must never pass through a text codec.
    const accepted =
      decoder instanceof UrDecoder
        ? decoder.receive(
            typeof input === 'string'
              ? input
              : new TextDecoder('utf-8', { fatal: true }).decode(input),
          )
        : decoder.receive(input as Uint8Array);
    if (accepted) {
      this.#decoder = decoder;
      this.#format = format;
    }
    return accepted;
  }
}
