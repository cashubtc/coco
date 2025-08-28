import type { Token } from '@cashu/cashu-ts';
import type { MintService, WalletService, ProofService } from '@core/services';
import { getDecodedToken } from '@cashu/cashu-ts';
import { UnknownMintError } from '@core/models';

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;

  constructor(mintService: MintService, walletService: WalletService, proofService: ProofService) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
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
    await this.proofService.saveProofs(mint, newProofs);
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
    await this.proofService.saveProofs(mintUrl, [...keep, ...send]);
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
}
