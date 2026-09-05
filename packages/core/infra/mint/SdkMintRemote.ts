import {
  Amount,
  OutputData,
  isBlsKeyset,
  type OutputDataCreator,
  type Wallet,
} from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import type { MintQuote } from '../../models/MintQuote.ts';
import type {
  PendingMintOperation,
  PendingOrLaterOperation,
} from '../../operations/mint/MintOperation.ts';
import type {
  MintIssuanceReceipt,
  MintRecoveryRecord,
} from '../../operations/mint/MintRecovery.ts';
import type { MintRemote } from '../../operations/mint/MintRemote.ts';
import type { KeyRingService } from '../../services/KeyRingService.ts';
import type { MintService } from '../../services/MintService.ts';
import type { SeedService } from '../../services/SeedService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import { deserializeOutputData, serializeOutputData } from '../../utils.ts';

export class SdkMintRemote implements MintRemote {
  constructor(
    private readonly wallets: Pick<WalletService, 'getWallet' | 'getWalletWithActiveKeysetId'>,
    private readonly mints: Pick<
      MintService,
      'isTrustedMint' | 'assertMethodUnitSupported' | 'getMintMethodUnitCapability'
    >,
    private readonly seeds: Pick<SeedService, 'getSeed'>,
    private readonly keys: Pick<KeyRingService, 'getMintQuoteKeyPair'>,
    private readonly outputs: OutputDataCreator = OutputData,
  ) {}
  isTrusted(mintUrl: string) {
    return this.mints.isTrustedMint(mintUrl);
  }
  async selectAmount(quote: MintQuote, available: Amount) {
    const capability = await this.mints.getMintMethodUnitCapability(
      quote.mintUrl,
      4,
      quote.method,
      quote.unit,
    );
    if (!capability.supported) return Amount.zero();
    const amount =
      capability.maxAmount && available.greaterThan(capability.maxAmount)
        ? capability.maxAmount
        : available;
    return capability.minAmount && amount.lessThan(capability.minAmount) ? Amount.zero() : amount;
  }
  async preflight(quote: MintQuote, amount: Amount) {
    if (!(await this.isTrusted(quote.mintUrl))) throw new Error('Mint is not trusted');
    await this.mints.assertMethodUnitSupported(quote.mintUrl, 4, quote.method, {
      amount,
      unit: quote.unit,
    });
    await this.signingKey(quote.method, quote.pubkey);
    const { keysetId, keys } = await this.wallets.getWalletWithActiveKeysetId(
      quote.mintUrl,
      quote.unit,
    );
    const seed = await this.seeds.getSeed();
    return {
      keysetId,
      derive: (counter: number) =>
        serializeOutputData({
          keep: this.outputs.createDeterministicData(amount, seed, counter, keys),
          send: [],
        }),
    };
  }
  private async signingKey(method: string, pubkey?: string) {
    if (!pubkey) {
      if (method !== 'bolt11') throw new Error('Mint quote requires a public key');
      return undefined;
    }
    const key = await this.keys.getMintQuoteKeyPair(pubkey);
    if (!key) throw new Error('Missing owned Mint quote key');
    return bytesToHex(key.secretKey);
  }
  async prepareRequest(operation: PendingMintOperation) {
    const wallet = await this.wallets.getWallet(operation.mintUrl, operation.unit);
    const data = deserializeOutputData(operation.outputData).keep;
    if (!data.length) throw new Error('Missing Mint output data');
    const privkey = await this.signingKey(operation.method, operation.pubkey);
    // The public SDK accepts Pick<MintQuoteBaseResponse, 'quote'>. Admission belongs to Coco;
    // pass the actual identity and ownership, without fabricating expiry or accounting fields.
    const preview = await wallet.prepareMint(
      operation.method,
      operation.amount,
      { quote: operation.quoteId, pubkey: operation.pubkey },
      { keysetId: data[0]!.blindedMessage.id, privkey },
      { type: 'custom', data },
    );
    if (
      JSON.stringify(serializeOutputData({ keep: preview.outputData, send: [] })) !==
      JSON.stringify(operation.outputData)
    )
      throw new Error('SDK changed persisted Mint outputs');
    return {
      request: {
        quote: preview.payload.quote,
        outputs: preview.payload.outputs.map((o) => ({ ...o, amount: o.amount.toString() })),
        ...(preview.payload.signature ? { signature: preview.payload.signature } : {}),
      },
      legacySignature: preview.legacySignature,
    };
  }
  async issue(operation: PendingOrLaterOperation, recovery: MintRecoveryRecord) {
    if (!recovery.request || recovery.request.quote !== operation.quoteId)
      throw new Error('Missing exact Mint request');
    const wallet = await this.wallets.getWallet(operation.mintUrl, operation.unit);
    const data = deserializeOutputData(operation.outputData).keep;
    if (!data.length) throw new Error('Missing Mint outputs');
    // Validate historical keys before I/O. completeMint uses getKeyset, not active-keyset admission.
    wallet.getKeyset(data[0]!.blindedMessage.id);
    const proofs = await wallet.completeMint({
      method: operation.method,
      quote: { quote: operation.quoteId },
      payload: {
        ...recovery.request,
        outputs: recovery.request.outputs.map((o) => ({ ...o, amount: Amount.from(o.amount) })),
      },
      outputData: data,
      keysetId: data[0]!.blindedMessage.id,
      // Deliberately omit legacySignature: the coordinator persists and owns every transmission.
    });
    return proofs.map(
      (proof, index): MintIssuanceReceipt => ({
        B_: data[index]!.blindedMessage.B_,
        proof: { ...proof, amount: proof.amount.toString() },
        state: 'UNSPENT',
      }),
    );
  }
  async restore(operation: PendingOrLaterOperation) {
    const wallet = await this.wallets.getWallet(operation.mintUrl, operation.unit);
    const data = deserializeOutputData(operation.outputData).keep;
    if (!data.length) throw new Error('Missing Mint outputs');
    const result = await wallet.mint.restore({ outputs: data.map((o) => o.blindedMessage) });
    if (result.outputs.length !== result.signatures.length)
      throw new Error('Malformed Mint Restore response');
    const seen = new Set<string>();
    const receipts = result.outputs.map((message, index): MintIssuanceReceipt => {
      const output = data.find((o) => o.blindedMessage.B_ === message.B_);
      const signature = result.signatures[index];
      if (
        !output ||
        !signature ||
        seen.has(message.B_) ||
        message.id !== output.blindedMessage.id ||
        !message.amount.equals(output.blindedMessage.amount)
      )
        throw new Error('Invalid exact-output Restore evidence');
      seen.add(message.B_);
      const keyset = wallet.getKeyset(signature.id);
      if (
        wallet.getMintInfo().isSupported(12).supported &&
        !signature.dleq &&
        !isBlsKeyset(signature.id)
      )
        throw new Error('Missing Restore DLEQ proof');
      const proof = output.toProof(signature, keyset);
      return {
        B_: message.B_,
        proof: { ...proof, amount: proof.amount.toString() },
        state: 'UNKNOWN',
      };
    });
    return this.checkStates(wallet, receipts);
  }
  async checkReceipts(operation: PendingOrLaterOperation, receipts: MintIssuanceReceipt[]) {
    const wallet = await this.wallets.getWallet(operation.mintUrl, operation.unit);
    return this.checkStates(wallet, receipts);
  }
  private async checkStates(wallet: Wallet, receipts: MintIssuanceReceipt[]) {
    if (!receipts.length) return [];
    try {
      const states = await wallet.checkProofsStates(
        receipts.map((r) => ({ ...r.proof, amount: Amount.from(r.proof.amount) })),
      );
      if (
        states.length !== receipts.length ||
        states.some((s) => !['UNSPENT', 'PENDING', 'SPENT'].includes(s.state))
      )
        throw new Error('Incomplete proof state response');
      return receipts.map((receipt, index) => ({ ...receipt, state: states[index]!.state }));
    } catch {
      // Signed outputs remain issuance evidence even when NUT-07 is unavailable.
      return receipts.map((receipt) => ({ ...receipt, state: 'UNKNOWN' as const }));
    }
  }
}
