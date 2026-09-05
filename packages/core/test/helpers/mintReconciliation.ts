import {
  Amount,
  Mint,
  Wallet,
  deriveKeysetId,
  type GetInfoResponse,
  type RequestFn,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { SdkMintRemote } from '../../infra/mint/SdkMintRemote.ts';
import {
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
  mintQuoteToMethodSnapshot,
  type MintQuote,
} from '../../models/MintQuote.ts';
import type { MintMethod } from '../../operations/mint/MintMethodHandler.ts';
import { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreMintTransactions } from '../../transactions/mint/MintTransactions.ts';

export async function mintFixture(
  method: MintMethod = 'bolt11',
  repositories = new MemoryRepositories(),
) {
  await repositories.init();
  const mintUrl = 'https://mint.test';
  const secretKey = new Uint8Array(32).fill(1);
  const quotePubkey = secp256k1.Point.BASE.multiply(
    BigInt('0x' + Buffer.from(secretKey).toString('hex')),
  ).toHex(true);
  const keypairs = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      String(2 ** index),
      secp256k1.Point.BASE.toHex(true),
    ]),
  );
  const keysetId = deriveKeysetId(keypairs, { unit: 'sat' });
  const info: GetInfoResponse = {
    name: 'Test Mint',
    version: 'test/1',
    pubkey: quotePubkey,
    contact: [],
    nuts: {
      '4': {
        methods: ['bolt11', 'bolt12', 'onchain'].map((method) => ({
          method,
          method_name: method,
          unit: 'sat',
          min_amount: 1,
          max_amount: 4095,
        })),
        disabled: false,
      },
      '5': { methods: [], disabled: false },
    },
  };
  const calls: { path: string; body: unknown }[] = [];
  const signed = new Map<
    string,
    { output: SerializedBlindedMessage; signature: SerializedBlindedSignature }
  >();
  const control = {
    issue: 'success' as
      | 'success'
      | 'timeout'
      | 'lost'
      | 'partial'
      | 'issued'
      | 'expired'
      | 'legacy'
      | 'malformed',
    restore: 'success' as 'success' | 'empty' | 'fail' | 'duplicate' | 'wrong-amount',
    proofState: 'UNSPENT' as 'UNSPENT' | 'SPENT' | 'PENDING' | 'fail',
    beforeIssue: undefined as (() => Promise<void>) | undefined,
    fullOnly: false,
    proofStates: undefined as undefined | Array<'UNSPENT' | 'SPENT' | 'PENDING'>,
    legacyQuoteState: undefined as undefined | 'UNPAID' | 'PAID' | 'ISSUED',
  };
  const request: RequestFn = async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    const path = new URL(args.endpoint).pathname;
    const body = args.requestBody as {
      outputs?: SerializedBlindedMessage[];
      signature?: string;
      Ys?: string[];
    };
    calls.push({ path, body: JSON.parse(JSON.stringify(body ?? null)) });
    let response: unknown;
    if (path.startsWith('/v1/mint/quote/')) {
      response = {
        ...mintQuoteToMethodSnapshot(await quote()),
        amount: method === 'bolt11' ? 100 : undefined,
      };
      if (control.legacyQuoteState)
        response = {
          quote: 'quote',
          request: 'request',
          amount: 100,
          unit: 'sat',
          expiry: 1,
          state: control.legacyQuoteState,
        };
    } else if (path.startsWith('/v1/mint/')) {
      await control.beforeIssue?.();
      if (control.issue === 'timeout') throw new Error('Network timeout');
      if (control.issue === 'issued')
        throw Object.assign(new Error('Quote already issued'), { code: 20002 });
      if (
        control.issue === 'expired' ||
        (control.fullOnly && !Amount.sum(body.outputs!.map((o) => o.amount)).equals(100))
      )
        throw Object.assign(new Error('Rejected exact request'), { code: 20007 });
      if (control.issue === 'legacy' && calls.filter((c) => c.path === path).length === 1)
        throw Object.assign(new Error('Invalid signature'), { code: 20008 });
      const outputs = control.issue === 'partial' ? body.outputs!.slice(0, 1) : body.outputs!;
      const signatures = outputs.map((output) => {
        // Mint key is 1: multiplication leaves B_ unchanged, while the SDK still unblinds and validates.
        const signature = { id: output.id, amount: Amount.from(output.amount), C_: output.B_ };
        signed.set(output.B_, {
          output: { ...output, amount: Amount.from(output.amount) },
          signature,
        });
        return signature;
      });
      if (control.issue === 'lost') throw new Error('Response lost after signing');
      response = {
        signatures:
          control.issue === 'malformed' ? signatures.map((s) => ({ ...s, amount: 3 })) : signatures,
      };
    } else if (path === '/v1/restore') {
      if (control.restore === 'fail') throw new Error('Restore unavailable');
      const found =
        control.restore === 'empty'
          ? []
          : body.outputs!.flatMap((o) => (signed.has(o.B_) ? [signed.get(o.B_)!] : []));
      if (control.restore === 'duplicate' && found[0]) found.push(found[0]);
      response = {
        outputs: found.map((x) =>
          control.restore === 'wrong-amount' ? { ...x.output, amount: 3 } : x.output,
        ),
        signatures: found.map((x) => x.signature),
      };
    } else if (path === '/v1/checkstate') {
      if (control.proofState === 'fail') throw new Error('Proof state unavailable');
      response = {
        states: body.Ys!.map((Y, index) => ({
          Y,
          state: control.proofStates?.[index] ?? control.proofState,
        })),
      };
    } else throw new Error(`Unexpected request ${path}`);
    return response as T;
  };
  const mint = new Mint(mintUrl, { customRequest: request });
  const wallet = new Wallet(mint, { unit: 'sat' });
  wallet.loadMintFromCache(info, {
    mintUrl,
    keysets: [{ id: keysetId, unit: 'sat', active: true, input_fee_ppk: 0, keys: keypairs }],
  });
  await repositories.mintRepository.addOrUpdateMint({
    mintUrl,
    name: 'Test Mint',
    mintInfo: info,
    trusted: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const common = {
    quote: 'quote',
    request: 'request',
    expiry: 1,
    unit: 'sat',
    amount_paid: Amount.from(100),
    amount_issued: Amount.zero(),
    updated_at: 1,
    pubkey: method === 'bolt11' ? undefined : quotePubkey,
  };
  const initial =
    method === 'bolt11'
      ? mintQuoteFromBolt11Response(mintUrl, {
          ...common,
          method,
          amount: Amount.from(100),
          state: 'PAID',
        })
      : method === 'bolt12'
        ? mintQuoteFromBolt12Response(mintUrl, {
            ...common,
            pubkey: quotePubkey,
            amount: null,
            method,
          })
        : mintQuoteFromOnchainResponse(mintUrl, { ...common, pubkey: quotePubkey, method });
  await repositories.mintQuoteRepository.upsertMintQuote(initial);
  async function quote(): Promise<MintQuote> {
    return (await repositories.mintQuoteRepository.getMintQuote(mintUrl, method, 'quote'))!;
  }
  const remote = new SdkMintRemote(
    {
      getWallet: async () => wallet,
      getWalletWithActiveKeysetId: async () => ({
        wallet,
        keysetId,
        keyset: { id: keysetId, unit: 'sat', active: true, input_fee_ppk: 0 },
        keys: { id: keysetId, unit: 'sat', keys: keypairs },
        unit: 'sat',
      }),
    },
    {
      isTrustedMint: (url) => repositories.mintRepository.isTrustedMint(url),
      assertMethodUnitSupported: async () => {},
      getMintMethodUnitCapability: async () => ({
        nut: 4,
        method,
        unit: 'sat',
        supported: true,
        disabled: false,
      }),
    },
    { getSeed: async () => new Uint8Array(64).fill(7) },
    {
      getMintQuoteKeyPair: async () => ({
        publicKeyHex: quotePubkey,
        secretKey,
        purpose: 'nut20_mint_quote',
        createdAt: 1,
      }),
    },
  );
  const events = new EventBus<CoreEvents>();
  const transactions = new CoreMintTransactions(new RepositoryCoreTransactionRunner(repositories));
  function service() {
    return new MintOperationService({
      operations: repositories.mintOperationRepository,
      proofs: repositories.proofRepository,
      recovery: repositories.mintRecoveryRepository,
      transactions,
      remote,
      events,
      quotes: {
        getMintQuote: () => quote(),
        getPendingMintQuotes: async () => [await quote()],
        requireMintQuoteRefForPrepare: () => quote(),
        refreshMintQuote: () => quote(),
      },
    });
  }
  return {
    service: service(),
    restart: service,
    repositories,
    quote,
    initial,
    remote,
    transactions,
    events,
    control,
    calls,
    signed,
    wallet,
    keysetId,
    mintUrl,
    async accounting(paid: number, issued: number) {
      await repositories.mintQuoteRepository.upsertMintQuote({
        ...(await quote()),
        amountPaid: Amount.from(paid),
        amountIssued: Amount.from(issued),
        remoteUpdatedAt: 2,
      });
    },
  };
}
