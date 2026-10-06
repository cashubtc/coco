import { decodeCbor } from './encoding.js';
import { decodeBytewords } from './internal/ur/bytewords.js';
import { FragmentChooser } from './internal/ur/fragments.js';
import { FountainSolver } from './internal/fountain.js';
import { crc32 } from './internal/crc32.js';

const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_PART_CHARACTERS = 131_072;
const MAX_FRAGMENT_COUNT = 1024;
const MAX_RECEIVED_PARTS = 8192;
const MAX_RECEIVED_BYTES = 16 * MAX_MESSAGE_BYTES;

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

/**
 * Reads complete ur:bytes strings containing a CBOR byte string.
 *
 * Bounds: 1 MiB wrapped message, 1024 source fragments, 131072 characters per
 * input, 8192 distinct parts and 16 MiB cumulative fragment input per session.
 * Reset to abandon a session or after reaching a bound. No UR encoder is exposed.
 */
export class UrDecoder {
  #solver: FountainSolver | undefined;
  #chooser: FragmentChooser | undefined;
  #result: Uint8Array | undefined;
  #received = new Set<number>();
  #receivedBytes = 0;
  #session: string | undefined;
  #fragmentCount: number | undefined;

  get isComplete(): boolean {
    return this.#result !== undefined;
  }
  get result(): Uint8Array | undefined {
    return this.#result?.slice();
  }
  /** Independent equations, not the number of accepted UR sequence numbers. */
  get independentFrames(): number {
    return this.#solver?.rank ?? (this.isComplete ? 1 : 0);
  }
  get fragmentCount(): number | undefined {
    return this.#fragmentCount;
  }
  /** Information collected, from 0 to 1; failed reconstruction resets to zero. */
  get progress(): number {
    if (this.isComplete) return 1;
    return this.#fragmentCount ? this.independentFrames / this.#fragmentCount : 0;
  }

  reset(): void {
    this.#solver = undefined;
    this.#chooser = undefined;
    this.#result = undefined;
    this.#received.clear();
    this.#receivedBytes = 0;
    this.#session = undefined;
    this.#fragmentCount = undefined;
  }

  /** True for an accepted new part, false for invalid, duplicate or foreign input. */
  receive(ur: string): boolean {
    if (this.isComplete || typeof ur !== 'string' || ur.length > MAX_PART_CHARACTERS) return false;
    const normalized = ur.toLowerCase();
    try {
      const components = normalized.split('/');
      if (components.shift() !== 'ur:bytes') return false;
      if (components.length === 1) {
        if (this.#session !== undefined) return false;
        const cbor = decodeBytewords(components[0]!);
        if (cbor.length > MAX_MESSAGE_BYTES) return false;
        const payload = decodeCbor(cbor);
        if (!(payload instanceof Uint8Array)) return false;
        this.#result = new Uint8Array(payload);
        this.#fragmentCount = 1;
        return true;
      }
      if (components.length !== 2 || !/^[1-9][0-9]*-[1-9][0-9]*$/.test(components[0]!))
        return false;
      const fields = decodeCbor(decodeBytewords(components[1]!));
      if (!Array.isArray(fields) || fields.length !== 5) return false;
      const [sequence, count, length, checksum, fragment]: unknown[] = fields;
      if (
        !isUint32(sequence) ||
        sequence === 0 ||
        !isUint32(count) ||
        count === 0 ||
        count > MAX_FRAGMENT_COUNT ||
        !isUint32(length) ||
        length === 0 ||
        length > MAX_MESSAGE_BYTES ||
        !isUint32(checksum) ||
        !(fragment instanceof Uint8Array) ||
        fragment.length === 0 ||
        length > count * fragment.length ||
        length <= (count - 1) * fragment.length ||
        components[0] !== `${sequence}-${count}`
      )
        return false;
      const session = `${count}:${length}:${checksum}:${fragment.length}`;
      if (
        (this.#session !== undefined && this.#session !== session) ||
        this.#received.has(sequence) ||
        this.#received.size >= MAX_RECEIVED_PARTS ||
        this.#receivedBytes + fragment.length > MAX_RECEIVED_BYTES
      )
        return false;
      this.#solver ??= new FountainSolver(count, fragment.length);
      this.#chooser ??= new FragmentChooser(count);
      this.#solver.add(this.#chooser.choose(sequence, checksum), fragment);
      this.#session = session;
      this.#fragmentCount = count;
      this.#received.add(sequence);
      this.#receivedBytes += fragment.length;
      if (this.#solver.rank === count) {
        const message = this.#solver.recover().subarray(0, length);
        if (crc32(message) !== checksum) {
          this.reset();
          return false;
        }
        const result = decodeCbor(message);
        if (!(result instanceof Uint8Array)) {
          this.reset();
          return false;
        }
        this.#result = new Uint8Array(result);
      }
      return true;
    } catch {
      // Parsing invalid individual parts leaves the active transfer intact. A
      // complete but malformed message must release the transfer for retry.
      if (this.#solver?.isComplete) this.reset();
      return false;
    }
  }
}
