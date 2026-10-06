/** Deterministic dense GF(2) repair coefficients; deliberately independent of UR. */
export function coefficients(sequence: number, count: number): Uint8Array {
  const bits = new Uint8Array(count);
  if (sequence <= count) {
    bits[sequence - 1] = 1;
    return bits;
  }
  let state = sequence >>> 0;
  let degree = 0;
  for (let i = 0; i < count; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = Math.imul(state ^ (state >>> 15), state | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    bits[i] = (word ^ (word >>> 14)) & 1;
    degree += bits[i]!;
  }
  if (degree === 0) bits[(sequence - 1) % count] = 1;
  return bits;
}
