import type { SerializedBlindedMessage, SerializedBlindedSignature } from '@cashu/cashu-ts';
import type { MintIssuanceTransport } from '../../operations/mint/MintIssuanceEngine.ts';

export type ScriptedMintIssuanceStep =
  | { kind: 'return'; signatures: SerializedBlindedSignature[] }
  | { kind: 'throw'; error: unknown }
  | {
      kind: 'run';
      run: (request: {
        mintUrl: string;
        quoteId: string;
        outputs: SerializedBlindedMessage[];
      }) => Promise<SerializedBlindedSignature[]>;
    };

/** Deterministic mint transport adapter for issuance-engine tests. */
export class ScriptedMintIssuanceTransport implements MintIssuanceTransport {
  readonly requests: Array<{
    mintUrl: string;
    quoteId: string;
    outputs: SerializedBlindedMessage[];
  }> = [];

  constructor(private readonly steps: ScriptedMintIssuanceStep[]) {}

  async mintBolt11(
    mintUrl: string,
    quoteId: string,
    outputs: SerializedBlindedMessage[],
  ): Promise<SerializedBlindedSignature[]> {
    this.requests.push({ mintUrl, quoteId, outputs });
    const step = this.steps.shift();
    if (!step) throw new Error('No scripted BOLT11 mint result remains');
    if (step.kind === 'throw') throw step.error;
    if (step.kind === 'run') return step.run({ mintUrl, quoteId, outputs });
    return step.signatures;
  }
}
