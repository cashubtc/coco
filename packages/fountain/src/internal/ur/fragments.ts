import { sha256 } from '@noble/hashes/sha2.js';

// Implements BCR-2024-001's consensus stack, using its IEEE-754 sampling order.
// https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md
const mask64 = (1n << 64n) - 1n;
const rotate = (word: bigint, shift: bigint) =>
  ((word << shift) | (word >> (64n - shift))) & mask64;

function randomSource(sequence: number, checksum: number): () => number {
  const seed = new Uint8Array(8);
  const seedView = new DataView(seed.buffer);
  seedView.setUint32(0, sequence);
  seedView.setUint32(4, checksum);
  const hash = sha256(seed);
  const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
  let a = view.getBigUint64(0),
    b = view.getBigUint64(8);
  let c = view.getBigUint64(16),
    d = view.getBigUint64(24);
  return () => {
    const result = (rotate((b * 5n) & mask64, 7n) * 9n) & mask64;
    const t = (b << 17n) & mask64;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotate(d, 45n);
    return Number(result) / 2 ** 64;
  };
}

/** The alias table depends only on source count and is retained per transfer. */
export class FragmentChooser {
  private readonly probabilities: number[];
  private readonly aliases: number[];

  constructor(private readonly count: number) {
    const weights = Array.from({ length: count }, (_, i) => 1 / (i + 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    const scaled = weights.map((weight) => (weight * count) / sum);
    const small: number[] = [],
      large: number[] = [];
    // This reverse ordering is part of MUR interoperability, not an optimization.
    for (let i = count - 1; i >= 0; i--) (scaled[i]! < 1 ? small : large).push(i);
    this.probabilities = new Array<number>(count).fill(1);
    this.aliases = new Array<number>(count).fill(0);
    while (small.length && large.length) {
      const lower = small.pop()!,
        upper = large.pop()!;
      this.probabilities[lower] = scaled[lower]!;
      this.aliases[lower] = upper;
      scaled[upper] = scaled[upper]! + (scaled[lower]! - 1);
      (scaled[upper]! < 1 ? small : large).push(upper);
    }
  }

  choose(sequence: number, checksum: number): Uint8Array {
    const selected = new Uint8Array(this.count);
    if (sequence <= this.count) {
      selected[sequence - 1] = 1;
      return selected;
    }
    const random = randomSource(sequence, checksum);
    const column = Math.floor(random() * this.count);
    const degree = (random() < this.probabilities[column]! ? column : this.aliases[column]!) + 1;
    const remaining = Array.from({ length: this.count }, (_, i) => i);
    // The reference removes a random element each time. Fisher-Yates would
    // produce different fragments. Only the selected prefix is needed here.
    for (let i = 0; i < degree; i++) {
      const [index] = remaining.splice(Math.floor(random() * remaining.length), 1);
      selected[index!] = 1;
    }
    return selected;
  }
}
