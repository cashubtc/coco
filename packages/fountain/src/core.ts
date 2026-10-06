import { coefficients } from './internal/core/equations.js';
import {
  parseFrame,
  serializeFrame,
  MAX_FRAGMENT_SIZE,
  MAX_FRAGMENTS,
  MAX_MESSAGE_LENGTH,
  type Metadata,
} from './internal/core/wire.js';

import { crc32 } from './internal/crc32.js';
import { FountainSolver } from './internal/fountain.js';

/** Experimental binary fountain transport. See docs/protocol.md for its wire format. */
export class FountainEncoder {
  /** Number of source fragments required to reconstruct this message. */
  readonly fragmentCount: number;
  private sequence = 0;
  private readonly message: Uint8Array;
  private readonly fragmentSize: number;
  private readonly checksum: number;

  constructor(message: Uint8Array, options: { fragmentSize?: number } = {}) {
    if (!(message instanceof Uint8Array)) throw new TypeError('Message must be a Uint8Array');
    this.fragmentSize = options.fragmentSize ?? 128;
    if (
      !Number.isInteger(this.fragmentSize) ||
      this.fragmentSize < 1 ||
      this.fragmentSize > MAX_FRAGMENT_SIZE
    ) {
      throw new RangeError(`fragmentSize must be an integer from 1 to ${MAX_FRAGMENT_SIZE}`);
    }
    this.fragmentCount = Math.max(1, Math.ceil(message.length / this.fragmentSize));
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new RangeError(`Message exceeds ${MAX_MESSAGE_LENGTH} bytes; use a smaller message`);
    }
    if (this.fragmentCount > MAX_FRAGMENTS) {
      throw new RangeError(
        `Message requires more than ${MAX_FRAGMENTS} fragments; use a larger fragmentSize or smaller message`,
      );
    }
    this.message = new Uint8Array(message);
    this.checksum = crc32(this.message);
  }

  /** Emit the next source or repair frame. Throws when the sequence space is exhausted. */
  nextFrame(): Uint8Array {
    if (this.sequence === 0xffffffff)
      throw new RangeError('Fountain sequence exhausted; create a new encoder');
    const sequence = ++this.sequence;
    const selected = coefficients(sequence, this.fragmentCount);
    const data = new Uint8Array(this.fragmentSize);
    for (let i = 0; i < selected.length; i++) {
      if (!selected[i]) continue;
      const start = i * this.fragmentSize;
      const fragment = this.message.subarray(start, start + this.fragmentSize);
      for (let j = 0; j < fragment.length; j++) data[j] = data[j]! ^ fragment[j]!;
    }
    return serializeFrame({
      sequence,
      count: this.fragmentCount,
      length: this.message.length,
      checksum: this.checksum,
      data,
    });
  }
}

/** Reconstructs one binary transfer at a time; reset before accepting another message. */
export class FountainDecoder {
  private solver?: FountainSolver;
  private decoded?: Uint8Array;
  private metadata?: Metadata;

  /** Whether reconstruction, checksum verification, and padding validation succeeded. */
  get isComplete(): boolean {
    return this.decoded !== undefined;
  }
  /** A defensive copy of the reconstructed bytes, or undefined until complete. */
  get result(): Uint8Array | undefined {
    return this.decoded?.slice();
  }

  /** Independent equations retained for this transfer, excluding redundant frames. */
  get independentFrames(): number {
    return this.solver?.rank ?? 0;
  }
  /** Source-fragment count; unknown until a frame establishes the transfer. */
  get fragmentCount(): number | undefined {
    return this.metadata?.count;
  }
  /** Information collected, from 0 to 1. A value of 1 means validated completion. */
  get progress(): number {
    if (this.isComplete) return 1;
    return this.fragmentCount ? this.independentFrames / this.fragmentCount : 0;
  }

  /**
   * Accept a complete frame. Returns true only for a new independent equation;
   * use isComplete for completion. Malformed, foreign, or corrupt frames throw.
   */
  receive(frame: Uint8Array): boolean {
    const parsed = parseFrame(frame);
    const { sequence, count, length, size, checksum } = parsed;
    if (
      this.metadata &&
      (this.metadata.count !== count ||
        this.metadata.length !== length ||
        this.metadata.size !== size ||
        this.metadata.checksum !== checksum)
    ) {
      throw new Error('Frame belongs to another message; reset the decoder first');
    }
    if (this.isComplete) return false;
    this.solver ??= new FountainSolver(count, size);
    const pivot = this.solver.add(coefficients(sequence, count), parsed.data);
    if (pivot === undefined) return false;
    this.metadata ??= { count, length, size, checksum };
    if (this.solver.isComplete) {
      const message = this.solver.recover();
      const decoded = message.slice(0, length);
      if (crc32(decoded) !== checksum || message.subarray(length).some((byte) => byte !== 0)) {
        this.solver.discard(pivot);
        throw new Error(
          'Reconstructed message checksum or padding mismatch; reset may be required',
        );
      }
      this.decoded = decoded;
    }
    return true;
  }

  /** Discard the transfer's equations, metadata, and result. */
  reset(): void {
    this.solver = undefined;
    this.decoded = undefined;
    this.metadata = undefined;
  }
}
