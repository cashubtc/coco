function xor(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] = target[i]! ^ source[i]!;
}

type Equation = { coefficients: Uint8Array; data: Uint8Array };

/** Incremental GF(2) elimination shared by binary and UR framing adapters. */
export class FountainSolver {
  private readonly rows = new Map<number, Equation>();
  constructor(
    private readonly count: number,
    private readonly size: number,
  ) {}
  get rank(): number {
    return this.rows.size;
  }
  get isComplete(): boolean {
    return this.rank === this.count;
  }

  /** Return the inserted pivot, or undefined for a dependent equation. */
  add(coefficients: Uint8Array, bytes: Uint8Array): number | undefined {
    const equation = { coefficients: new Uint8Array(coefficients), data: new Uint8Array(bytes) };
    for (let i = 0; i < this.count; i++) {
      if (!equation.coefficients[i]) continue;
      const row = this.rows.get(i);
      if (row) {
        xor(equation.coefficients, row.coefficients);
        xor(equation.data, row.data);
      } else {
        this.rows.set(i, equation);
        return i;
      }
    }
    return undefined;
  }

  discard(pivot: number): void {
    this.rows.delete(pivot);
  }

  recover(): Uint8Array {
    if (this.rank !== this.count) throw new Error('Not enough independent fountain parts');
    const message = new Uint8Array(this.count * this.size);
    for (let i = this.count - 1; i >= 0; i--) {
      const row = this.rows.get(i)!;
      const fragment = row.data.slice();
      for (let j = i + 1; j < this.count; j++) {
        if (row.coefficients[j])
          xor(fragment, message.subarray(j * this.size, (j + 1) * this.size));
      }
      message.set(fragment, i * this.size);
    }
    return message;
  }
}
