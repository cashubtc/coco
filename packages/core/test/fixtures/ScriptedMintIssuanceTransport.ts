import type { BatchMintPreview, Proof } from '@cashu/cashu-ts';
import type {
  MintMethod,
  MintMethodQuoteSnapshot,
} from '../../operations/mint/MintMethodHandler.ts';

export type ScriptedStep<T> = { kind: 'return'; value: T } | { kind: 'throw'; error: unknown };

/** Narrow deterministic fixture for Mint Batch submission and NUT-29 quote-check faults. */
export class ScriptedMintIssuanceTransport {
  readonly batchSubmissions: BatchMintPreview[] = [];
  readonly quoteChecks: Array<{ mintUrl: string; method: MintMethod; quoteIds: string[] }> = [];
  readonly restoreRequests: Array<{ mintUrl: string; attemptId?: string }> = [];

  constructor(
    private readonly batchSteps: ScriptedStep<Proof[]>[],
    private readonly quoteCheckSteps: ScriptedStep<MintMethodQuoteSnapshot[]>[],
    private readonly restoreSteps: ScriptedStep<Proof[]>[] = [],
  ) {}

  completeBatchMint = async (preview: BatchMintPreview): Promise<Proof[]> => {
    this.batchSubmissions.push(preview);
    return this.runNext(this.batchSteps, 'Mint Batch submission');
  };

  checkMintQuoteBatch = async (
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
  ): Promise<MintMethodQuoteSnapshot[]> => {
    this.quoteChecks.push({ mintUrl, method, quoteIds: [...quoteIds] });
    return this.runNext(this.quoteCheckSteps, 'NUT-29 quote check');
  };

  restoreExactOutputs = async (
    mintUrl: string,
    _outputData: unknown,
    options: { createdByAttemptId?: string },
  ): Promise<Proof[]> => {
    this.restoreRequests.push({ mintUrl, attemptId: options.createdByAttemptId });
    return this.runNext(this.restoreSteps, 'NUT-09 Restore');
  };

  private async runNext<T>(steps: ScriptedStep<T>[], boundary: string): Promise<T> {
    const step = steps.shift();
    if (!step) throw new Error(`No scripted ${boundary} result remains`);
    if (step.kind === 'throw') throw step.error;
    return step.value;
  }
}
