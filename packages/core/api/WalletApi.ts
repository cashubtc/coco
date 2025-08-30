import type { Proof, Token } from '@cashu/cashu-ts';
import type { MintService, WalletService, ProofService, CounterService } from '@core/services';
import { getDecodedToken } from '@cashu/cashu-ts';
import { UnknownMintError } from '@core/models';
import { mapProofToCoreProof } from '@core/utils';
import type { Logger } from '../logging/Logger.ts';

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private counterService: CounterService;
  private readonly logger?: Logger;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    counterService: CounterService,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.counterService = counterService;
    this.logger = logger;
  }

  async receive(token: Token | string) {
    const { mint, proofs }: Token = typeof token === 'string' ? getDecodedToken(token) : token;

    const known = await this.mintService.isKnownMint(mint);
    if (!known) {
      throw new UnknownMintError(`Mint ${mint} is not known`);
    }

    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mint);
    const receiveAmount = proofs.reduce((acc, proof) => acc + proof.amount, 0);
    const { keep: outputData } = await this.proofService.createOutputsAndIncrementCounters(mint, {
      keep: receiveAmount,
      send: 0,
    });
    const newProofs = await wallet.receive({ mint, proofs }, { outputData });
    await this.proofService.saveProofs(mint, mapProofToCoreProof(mint, 'ready', newProofs));
  }

  async send(mintUrl: string, amount: number): Promise<Token> {
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, amount);
    const selectedAmount = selectedProofs.reduce((acc, proof) => acc + proof.amount, 0);
    const outputData = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: selectedAmount - amount,
      send: amount,
    });
    const { send, keep } = await wallet.send(amount, selectedProofs, { outputData });
    await this.proofService.saveProofs(
      mintUrl,
      mapProofToCoreProof(mintUrl, 'ready', [...keep, ...send]),
    );
    await this.proofService.setProofState(
      mintUrl,
      selectedProofs.map((proof) => proof.secret),
      'spent',
    );
    await this.proofService.setProofState(
      mintUrl,
      send.map((proof) => proof.secret),
      'inflight',
    );
    return {
      mint: mintUrl,
      proofs: send,
    };
  }

  async getBalances(): Promise<{ [mintUrl: string]: number }> {
    const proofs = await this.proofService.getAllReadyProofs();
    const balances: { [mintUrl: string]: number } = {};
    for (const proof of proofs) {
      const mintUrl = proof.mintUrl;
      const balance = balances[mintUrl] || 0;
      balances[mintUrl] = balance + proof.amount;
    }
    return balances;
  }

  async restore(mintUrl: string) {
    this.logger?.info('Starting restore', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl);
    this.logger?.debug('Mint fetched for restore', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const failedKeysetIds: { [keysetId: string]: Error } = {};
    for (const keyset of mint.keysets) {
      this.logger?.debug('Restoring keyset', { mintUrl, keysetId: keyset.id });
      const oldProofs = await this.proofService.getProofsByKeysetId(mintUrl, keyset.id);
      this.logger?.debug('Existing proofs before restore', {
        mintUrl,
        keysetId: keyset.id,
        count: oldProofs.length,
      });
      try {
        const { proofs, lastCounterWithSignature } = await wallet.batchRestore(
          300,
          100,
          0,
          keyset.id,
        );
        if (proofs.length === 0) {
          this.logger?.warn('No proofs to restore', {
            mintUrl,
            keysetId: keyset.id,
          });
          continue;
        }
        this.logger?.info('Batch restore result', {
          mintUrl,
          keysetId: keyset.id,
          restored: proofs.length,
          lastCounterWithSignature,
        });
        if (oldProofs.length > proofs.length) {
          this.logger?.warn('Restored fewer proofs than previously stored', {
            mintUrl,
            keysetId: keyset.id,
            previous: oldProofs.length,
            restored: proofs.length,
          });
          failedKeysetIds[keyset.id] = new Error('Restored less proofs than expected.');
        }
        const states = await wallet.checkProofsStates(proofs);
        const checkedProofs: { spent: Proof[]; ready: Proof[] } = { spent: [], ready: [] };
        for (const [index, state] of states.entries()) {
          if (!proofs[index]) {
            this.logger?.error('Malformed state check', {
              mintUrl,
              keysetId: keyset.id,
              index,
            });
            failedKeysetIds[keyset.id] = new Error('Malformed state check');
            break;
          }
          if (state.state === 'SPENT') {
            checkedProofs.spent.push(proofs[index]);
          } else {
            checkedProofs.ready.push(proofs[index]);
          }
        }
        this.logger?.debug('Checked proof states', {
          mintUrl,
          keysetId: keyset.id,
          ready: checkedProofs.ready.length,
          spent: checkedProofs.spent.length,
        });
        await this.counterService.overwriteCounter(
          mintUrl,
          keyset.id,
          lastCounterWithSignature ? lastCounterWithSignature + 1 : 0,
        );
        this.logger?.debug('Requested counter overwrite for keyset', {
          mintUrl,
          keysetId: keyset.id,
          counter: lastCounterWithSignature ? lastCounterWithSignature + 1 : 0,
        });
        await this.proofService.saveProofs(mintUrl, [
          ...mapProofToCoreProof(mintUrl, 'ready', checkedProofs.ready),
          ...mapProofToCoreProof(mintUrl, 'spent', checkedProofs.spent),
        ]);
        this.logger?.info('Saved restored proofs for keyset', {
          mintUrl,
          keysetId: keyset.id,
          total: checkedProofs.ready.length + checkedProofs.spent.length,
        });
      } catch (error) {
        this.logger?.error('Keyset restore failed', { mintUrl, keysetId: keyset.id, error });
        failedKeysetIds[keyset.id] = error as Error;
      }
    }
    if (Object.keys(failedKeysetIds).length > 0) {
      this.logger?.error('Restore completed with failures', {
        mintUrl,
        failedKeysetIds: Object.keys(failedKeysetIds),
      });
      throw new Error('Failed to restore some keysets');
    }
    this.logger?.info('Restore completed successfully', { mintUrl });
  }
}
