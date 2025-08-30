import type { Token } from '@cashu/cashu-ts';
import type {
  MintService,
  WalletService,
  ProofService,
  WalletRestoreService,
} from '@core/services';
import { getDecodedToken } from '@cashu/cashu-ts';
import { UnknownMintError } from '@core/models';
import { mapProofToCoreProof } from '@core/utils';
import type { Logger } from '../logging/Logger.ts';

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private readonly logger?: Logger;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    walletRestoreService: WalletRestoreService,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.walletRestoreService = walletRestoreService;
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

  // Restoration logic is delegated to WalletRestoreService

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
      try {
        await this.walletRestoreService.restoreKeyset(mintUrl, wallet, keyset.id);
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
