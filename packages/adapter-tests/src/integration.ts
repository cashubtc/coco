import type { Repositories, Manager, Logger } from 'coco-cashu-core';
import { initializeCoco, getEncodedToken } from 'coco-cashu-core';
import {
  CashuMint,
  CashuWallet,
  OutputData,
  PaymentRequest,
  PaymentRequestTransportType,
  type MintKeys,
  type Token,
} from '@cashu/cashu-ts';
import { createFakeInvoice } from 'fake-bolt11';

export type OutputDataFactory = (amount: number, keys: MintKeys) => OutputData;

export type IntegrationTestRunner = {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void, timeout?: number): void;
  beforeEach(fn: () => Promise<void> | void): void;
  afterEach(fn: () => Promise<void> | void): void;
  expect: Expectation;
};

type Expectation = {
  (value: unknown): ExpectApi;
};

type ExpectApi = {
  toBe(value: unknown): void;
  toBeDefined(): void;
  toBeGreaterThan(value: number): void;
  toBeGreaterThanOrEqual(value: number): void;
  toBeLessThan(value: number): void;
  toBeLessThanOrEqual(value: number): void;
  toHaveLength(len: number): void;
  toContain(value: unknown): void;
  rejects: {
    toThrow(): Promise<void>;
  };
};

export type IntegrationTestOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: () => Promise<{
    repositories: TRepositories;
    dispose(): Promise<void>;
  }>;
  mintUrl: string;
  logger?: Logger;
  suiteName?: string;
};

export async function runIntegrationTests<TRepositories extends Repositories = Repositories>(
  options: IntegrationTestOptions<TRepositories>,
  runner: IntegrationTestRunner,
): Promise<void> {
  const { describe, it, beforeEach, afterEach, expect } = runner;
  const { createRepositories, mintUrl, logger, suiteName = 'Integration Tests' } = options;

  describe(suiteName, () => {
    let mgr: Manager | undefined;
    let seedGetter: () => Promise<Uint8Array>;

    const createSeedGetter = async () => {
      const seed = crypto.getRandomValues(new Uint8Array(64));
      return async () => seed;
    };

    beforeEach(async () => {
      seedGetter = await createSeedGetter();
    });

    afterEach(async () => {
      if (mgr) {
        await mgr.pauseSubscriptions();
        await mgr.dispose();
        mgr = undefined;
      }
    });

    describe('Mint Management', () => {
      it('should add a mint and fetch mint info', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const { mint, keysets } = await mgr.mint.addMint(mintUrl, { trusted: true });
          expect(mint.mintUrl).toBe(mintUrl);
          expect(keysets.length).toBeGreaterThan(0);

          const mintInfo = await mgr.mint.getMintInfo(mintUrl);
          expect(mintInfo.name).toBeDefined();
          expect(mintInfo.version).toBeDefined();

          const isKnown = await mgr.mint.isTrustedMint(mintUrl);
          expect(isKnown).toBe(true);

          const allMints = await mgr.mint.getAllMints();
          expect(allMints).toHaveLength(1);
          expect(allMints[0]?.mintUrl).toBe(mintUrl);

          const trustedMints = await mgr.mint.getAllTrustedMints();
          expect(trustedMints).toHaveLength(1);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should handle trust and untrust operations', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          await mgr.mint.addMint(mintUrl, { trusted: false });
          expect(await mgr.mint.isTrustedMint(mintUrl)).toBe(false);

          await mgr.mint.trustMint(mintUrl);
          expect(await mgr.mint.isTrustedMint(mintUrl)).toBe(true);

          await mgr.mint.untrustMint(mintUrl);
          expect(await mgr.mint.isTrustedMint(mintUrl)).toBe(false);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should emit mint:added event', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const eventPromise = new Promise((resolve) => {
            mgr!.once('mint:added', (payload) => {
              expect(payload.mint.mintUrl).toBe(mintUrl);
              expect(payload.keysets.length).toBeGreaterThan(0);
              resolve(payload);
            });
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });
          await eventPromise;
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });
    });

    describe('Mint Quote Workflow', () => {
      it('should create and redeem a mint quote manually', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
            processors: {
              mintQuoteProcessor: {
                disabled: true,
              },
            },
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const initialBalance = await mgr.wallet.getBalances();
          expect(initialBalance[mintUrl] || 0).toBe(0);

          const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
          expect(quote.quote).toBeDefined();
          expect(quote.request).toBeDefined();
          expect(quote.amount).toBe(100);

          const eventPromise = new Promise((resolve) => {
            mgr!.once('mint-quote:created', (payload) => {
              expect(payload.mintUrl).toBe(mintUrl);
              expect(payload.quoteId).toBe(quote.quote);
              resolve(payload);
            });
          });

          await new Promise((resolve) => {
            mgr!.once('mint-quote:state-changed', (payload) => {
              if (payload.state === 'PAID') {
                expect(payload.mintUrl).toBe(mintUrl);
                expect(payload.quoteId).toBe(quote.quote);
                resolve(payload);
              }
            });
          });

          const redeemPromise = new Promise((res) => {
            mgr!.quotes.redeemMintQuote(mintUrl, quote.quote).then(() => {
              res(void 0);
            });
          });

          const redeemedEventPromise = new Promise((resolve) => {
            mgr!.once('mint-quote:redeemed', (payload) => {
              expect(payload.mintUrl).toBe(mintUrl);
              expect(payload.quoteId).toBe(quote.quote);
              resolve(payload);
            });
          });

          await Promise.all([redeemPromise, redeemedEventPromise]);

          const balance = await mgr.wallet.getBalances();
          expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(100);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should use subscription API to await mint quote paid', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
            processors: {
              mintQuoteProcessor: {
                disabled: true,
              },
            },
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const quote = await mgr.quotes.createMintQuote(mintUrl, 50);

          const subscriptionPromise = await mgr.subscription.awaitMintQuotePaid(
            mintUrl,
            quote.quote,
          );
          const redeemPromise = await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

          const balance = await mgr.wallet.getBalances();
          expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(50);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });
    });

    describe('Wallet Operations', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
        });

        await mgr.mint.addMint(mintUrl, { trusted: true });

        const quote = await mgr.quotes.createMintQuote(mintUrl, 200);
        await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      });

      afterEach(async () => {
        if (repositoriesDispose) {
          await repositoriesDispose();
          repositoriesDispose = undefined;
        }
      });

      it('should send tokens and update balance', async () => {
        const initialBalance = await mgr!.wallet.getBalances();
        const initialAmount = initialBalance[mintUrl] || 0;
        expect(initialAmount).toBeGreaterThanOrEqual(200);

        const sendAmount = 50;
        const sendPromise = new Promise((resolve) => {
          mgr!.once('send:created', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            expect(payload.token.proofs.length).toBeGreaterThan(0);
            const tokenAmount = payload.token.proofs.reduce((sum, p) => sum + p.amount, 0);
            expect(tokenAmount).toBeGreaterThanOrEqual(sendAmount);
            resolve(payload);
          });
        });

        const token = await mgr!.wallet.send(mintUrl, sendAmount);
        await sendPromise;

        expect(token.mint).toBe(mintUrl);
        expect(token.proofs.length).toBeGreaterThan(0);

        const balanceAfterSend = await mgr!.wallet.getBalances();
        const amountAfterSend = balanceAfterSend[mintUrl] || 0;
        expect(amountAfterSend).toBeLessThan(initialAmount);
      });

      it('should receive tokens and update balance', async () => {
        const initialBalance = await mgr!.wallet.getBalances();
        const initialAmount = initialBalance[mintUrl] || 0;

        const sendAmount = 30;
        const token = await mgr!.wallet.send(mintUrl, sendAmount);

        const balanceAfterSend = await mgr!.wallet.getBalances();
        const amountAfterSend = balanceAfterSend[mintUrl] || 0;

        const receivePromise = new Promise((resolve) => {
          mgr!.once('receive:created', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            expect(payload.token.proofs.length).toBeGreaterThan(0);
            resolve(payload);
          });
        });

        await mgr!.wallet.receive(token);
        await receivePromise;

        const balanceAfterReceive = await mgr!.wallet.getBalances();
        const amountAfterReceive = balanceAfterReceive[mintUrl] || 0;
        expect(amountAfterReceive).toBeGreaterThan(amountAfterSend);
      });

      it('should receive tokens from encoded string', async () => {
        const sendAmount = 25;
        const token = await mgr!.wallet.send(mintUrl, sendAmount);

        const encodedToken = getEncodedToken(token);

        const balanceBeforeReceive = await mgr!.wallet.getBalances();
        const amountBeforeReceive = balanceBeforeReceive[mintUrl] || 0;

        await mgr!.wallet.receive(encodedToken);

        const balanceAfterReceive = await mgr!.wallet.getBalances();
        const amountAfterReceive = balanceAfterReceive[mintUrl] || 0;
        expect(amountAfterReceive).toBeGreaterThan(amountBeforeReceive);
      });

      it('should handle multiple send/receive operations', async () => {
        const initialBalance = await mgr!.wallet.getBalances();
        const initialAmount = initialBalance[mintUrl] || 0;

        const amounts = [10, 20, 15];
        const tokens: Token[] = [];

        for (const amount of amounts) {
          const token = await mgr!.wallet.send(mintUrl, amount);
          tokens.push(token);
        }

        const balanceAfterSends = await mgr!.wallet.getBalances();
        const amountAfterSends = balanceAfterSends[mintUrl] || 0;
        expect(amountAfterSends).toBeLessThan(initialAmount - amounts.reduce((a, b) => a + b, 0));

        for (const token of tokens) {
          await mgr!.wallet.receive(token);
        }

        const finalBalance = await mgr!.wallet.getBalances();
        const finalAmount = finalBalance[mintUrl] || 0;
        expect(finalAmount).toBeGreaterThanOrEqual(
          initialAmount - amounts.reduce((a, b) => a + b, 0),
        );
      });

      it('should reject receiving tokens from untrusted mint', async () => {
        const untrustedMintUrl = 'https://untrusted.example.com';
        const fakeToken: Token = {
          mint: untrustedMintUrl,
          proofs: [],
        };

        await expect(mgr!.wallet.receive(fakeToken)).rejects.toThrow();
      });
    });

    describe('Melt Quote Workflow', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
        });

        const { mint, keysets } = await mgr.mint.addMint(mintUrl, { trusted: true });

        const quote = await mgr.quotes.createMintQuote(mintUrl, 500);
        await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      });

      afterEach(async () => {
        if (repositoriesDispose) {
          await repositoriesDispose();
          repositoriesDispose = undefined;
        }
      });

      it('should create a melt quote', async () => {
        const eventPromise = new Promise((resolve) => {
          mgr!.once('melt-quote:created', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            resolve(payload);
          });
        });
        const invoice = createFakeInvoice(100);
        const meltQuote = await mgr!.quotes.createMeltQuote(mintUrl, invoice);

        expect(meltQuote.quote).toBeDefined();
        expect(meltQuote.amount).toBeGreaterThan(0);

        await eventPromise;
      });

      it('should pay a melt quote (may skip swap if exact amount)', async () => {
        const invoice = createFakeInvoice(20);
        const meltQuote = await mgr!.quotes.createMeltQuote(mintUrl, invoice);

        expect(meltQuote.quote).toBeDefined();
        expect(meltQuote.amount).toBeGreaterThan(0);

        const balanceBefore = await mgr!.wallet.getBalances();
        const balanceBeforeAmount = balanceBefore[mintUrl] || 0;

        const paidEventPromise = new Promise((resolve) => {
          mgr!.once('melt-quote:paid', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            expect(payload.quoteId).toBe(meltQuote.quote);
            resolve(payload);
          });
        });

        const stateChangedEventPromise = new Promise((resolve) => {
          mgr!.once('melt-quote:state-changed', (payload) => {
            if (payload.state === 'PAID') {
              expect(payload.mintUrl).toBe(mintUrl);
              expect(payload.quoteId).toBe(meltQuote.quote);
              resolve(payload);
            }
          });
        });

        await mgr!.quotes.payMeltQuote(mintUrl, meltQuote.quote);

        await Promise.all([paidEventPromise, stateChangedEventPromise]);

        const balanceAfter = await mgr!.wallet.getBalances();
        const balanceAfterAmount = balanceAfter[mintUrl] || 0;
        const amountWithFee = meltQuote.amount + meltQuote.fee_reserve;

        // Balance should decrease by at least the amount + fee
        expect(balanceAfterAmount).toBeLessThanOrEqual(balanceBeforeAmount - amountWithFee);
      });
    });

    describe('History', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
        });

        await mgr.mint.addMint(mintUrl, { trusted: true });

        const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
        await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      });

      afterEach(async () => {
        if (repositoriesDispose) {
          await repositoriesDispose();
          repositoriesDispose = undefined;
        }
      });

      it('should retrieve paginated history', async () => {
        const history = await mgr!.history.getPaginatedHistory(0, 10);
        expect(Array.isArray(history)).toBe(true);
      });
    });

    describe('Event System', () => {
      it('should emit counter:updated events', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const counterEvents: unknown[] = [];
          const unsubscribe = mgr.on('counter:updated', (payload) => {
            counterEvents.push(payload);
          });

          const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
          await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

          await new Promise((resolve) => setTimeout(resolve, 1000));

          expect(counterEvents.length).toBeGreaterThan(0);
          unsubscribe();
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should emit proofs:saved events', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const proofsEvents: unknown[] = [];
          const unsubscribe = mgr.on('proofs:saved', (payload) => {
            proofsEvents.push(payload);
          });

          const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
          await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

          await new Promise((resolve) => setTimeout(resolve, 1000));

          expect(proofsEvents.length).toBeGreaterThan(0);
          unsubscribe();
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should emit proofs:state-changed events on send', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const quote = await mgr.quotes.createMintQuote(mintUrl, 200);
          await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

          const stateChanges: unknown[] = [];
          const unsubscribe = mgr.on('proofs:state-changed', (payload) => {
            stateChanges.push(payload);
          });

          await mgr.wallet.send(mintUrl, 50);

          await new Promise((resolve) => setTimeout(resolve, 500));

          expect(stateChanges.length).toBeGreaterThan(0);
          const spentChange = stateChanges.find(
            (p: any) => p.mintUrl === mintUrl && p.state === 'spent',
          );
          expect(spentChange).toBeDefined();

          const inflightChange = stateChanges.find(
            (p: any) => p.mintUrl === mintUrl && p.state === 'inflight',
          );
          expect(inflightChange).toBeDefined();

          unsubscribe();
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });
    });

    describe('Watchers and Processors', () => {
      it('should automatically process paid mint quotes with watcher enabled', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
            watchers: {
              mintQuoteWatcher: {
                watchExistingPendingOnStart: false,
              },
            },
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const initialBalance = await mgr.wallet.getBalances();
          expect(initialBalance[mintUrl] || 0).toBe(0);

          const quote = await mgr.quotes.createMintQuote(mintUrl, 150);

          const redeemedPromise = new Promise((resolve) => {
            mgr!.once('mint-quote:redeemed', (payload) => {
              expect(payload.mintUrl).toBe(mintUrl);
              expect(payload.quoteId).toBe(quote.quote);
              resolve(payload);
            });
          });

          await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
          await redeemedPromise;

          const balance = await mgr.wallet.getBalances();
          expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(150);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should handle pause and resume subscriptions', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          await mgr.pauseSubscriptions();
          await mgr.resumeSubscriptions();

          const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
          await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

          const balance = await mgr.wallet.getBalances();
          expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(100);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });
    });

    describe('Full Workflow Integration', () => {
      it('should perform complete end-to-end workflow', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const initialBalance = await mgr.wallet.getBalances();
          expect(initialBalance[mintUrl] || 0).toBe(0);

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const mintQuote = await mgr.quotes.createMintQuote(mintUrl, 500);
          expect(mintQuote.amount).toBe(500);

          await mgr.quotes.redeemMintQuote(mintUrl, mintQuote.quote);

          const balanceAfterMint = await mgr.wallet.getBalances();
          expect(balanceAfterMint[mintUrl] || 0).toBeGreaterThanOrEqual(500);

          const sendAmount = 100;
          const token1 = await mgr.wallet.send(mintUrl, sendAmount);
          expect(token1.proofs.length).toBeGreaterThan(0);

          const balanceAfterSend = await mgr.wallet.getBalances();
          const amountAfterSend = balanceAfterSend[mintUrl] || 0;
          expect(amountAfterSend).toBeLessThan(balanceAfterMint[mintUrl] || 0);

          await mgr.wallet.receive(token1);

          const balanceAfterReceive = await mgr.wallet.getBalances();
          const amountAfterReceive = balanceAfterReceive[mintUrl] || 0;
          expect(amountAfterReceive).toBeGreaterThan(amountAfterSend);

          const token2 = await mgr.wallet.send(mintUrl, 50);
          await mgr.wallet.receive(token2);

          const finalBalance = await mgr.wallet.getBalances();
          expect(finalBalance[mintUrl] || 0).toBeGreaterThanOrEqual(400);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });
    });

    describe('KeyRing Management', () => {
      it('should generate keypair and return secret key when dumpSecretKey is true', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const keypair = await mgr.keyring.generateKeyPair(true);

          expect(keypair.publicKeyHex).toBeDefined();
          expect(keypair.publicKeyHex.length).toBe(66); // 33 bytes in hex
          expect(keypair.secretKey).toBeDefined();
          expect(keypair.secretKey.length).toBe(32);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should retrieve a keypair by public key', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const generated = await mgr.keyring.generateKeyPair(true);
          const retrieved = await mgr.keyring.getKeyPair(generated.publicKeyHex);

          expect(retrieved).toBeDefined();
          expect(retrieved?.publicKeyHex).toBe(generated.publicKeyHex);
          expect(retrieved?.secretKey).toBeDefined();
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should return null for non-existent keypair', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const fakePublicKey = '02' + '00'.repeat(32);
          const retrieved = await mgr.keyring.getKeyPair(fakePublicKey);

          expect(retrieved).toBe(null);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should get latest keypair', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const kp1 = await mgr.keyring.generateKeyPair();
          const kp2 = await mgr.keyring.generateKeyPair();
          const kp3 = await mgr.keyring.generateKeyPair();

          const latest = await mgr.keyring.getLatestKeyPair();

          expect(latest).toBeDefined();
          expect(latest?.publicKeyHex).toBe(kp3.publicKeyHex);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should return null for latest keypair when none exist', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const latest = await mgr.keyring.getLatestKeyPair();

          expect(latest).toBe(null);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should get all keypairs', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const kp1 = await mgr.keyring.generateKeyPair();
          const kp2 = await mgr.keyring.generateKeyPair();
          const secretKey = crypto.getRandomValues(new Uint8Array(32));
          const kp3 = await mgr.keyring.addKeyPair(secretKey);

          const allKeypairs = await mgr.keyring.getAllKeyPairs();

          expect(allKeypairs.length).toBe(3);
          const publicKeys = allKeypairs.map((kp) => kp.publicKeyHex);
          expect(publicKeys).toContain(kp1.publicKeyHex);
          expect(publicKeys).toContain(kp2.publicKeyHex);
          expect(publicKeys).toContain(kp3.publicKeyHex);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should remove a keypair', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          const kp1 = await mgr.keyring.generateKeyPair();
          const kp2 = await mgr.keyring.generateKeyPair();

          // Verify both exist
          let allKeypairs = await mgr.keyring.getAllKeyPairs();
          expect(allKeypairs.length).toBe(2);

          // Remove one
          await mgr.keyring.removeKeyPair(kp1.publicKeyHex);

          // Verify only one remains
          allKeypairs = await mgr.keyring.getAllKeyPairs();
          expect(allKeypairs.length).toBe(1);
          expect(allKeypairs[0]?.publicKeyHex).toBe(kp2.publicKeyHex);

          // Verify removed keypair returns null
          const removed = await mgr.keyring.getKeyPair(kp1.publicKeyHex);
          expect(removed).toBe(null);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should generate deterministic keypairs from same seed', async () => {
        const { repositories: repo1, dispose: dispose1 } = await createRepositories();
        const { repositories: repo2, dispose: dispose2 } = await createRepositories();

        // Use same seed for both managers
        const sharedSeed = crypto.getRandomValues(new Uint8Array(64));
        const sharedSeedGetter = async () => sharedSeed;

        try {
          // First manager generates keypairs
          const mgr1 = await initializeCoco({
            repo: repo1,
            seedGetter: sharedSeedGetter,
            logger,
          });

          const kp1_1 = await mgr1.keyring.generateKeyPair(true);
          const kp1_2 = await mgr1.keyring.generateKeyPair(true);

          await mgr1.pauseSubscriptions();
          await mgr1.dispose();

          // Second manager with same seed generates keypairs
          const mgr2 = await initializeCoco({
            repo: repo2,
            seedGetter: sharedSeedGetter,
            logger,
          });

          const kp2_1 = await mgr2.keyring.generateKeyPair(true);
          const kp2_2 = await mgr2.keyring.generateKeyPair(true);

          await mgr2.pauseSubscriptions();
          await mgr2.dispose();

          // Keypairs should be identical (deterministic derivation)
          expect(kp1_1.publicKeyHex).toBe(kp2_1.publicKeyHex);
          expect(kp1_2.publicKeyHex).toBe(kp2_2.publicKeyHex);
        } finally {
          await dispose1();
          await dispose2();
        }
      });
    });

    describe('P2PK (Pay-to-Public-Key)', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
        });

        await mgr.mint.addMint(mintUrl, { trusted: true });

        // Fund the wallet
        const quote = await mgr.quotes.createMintQuote(mintUrl, 200);
        await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      });

      afterEach(async () => {
        if (repositoriesDispose) {
          await repositoriesDispose();
          repositoriesDispose = undefined;
        }
      });
      it('should receive token with P2PK locked proofs using added keypair', async () => {
        // Generate a keypair using the KeyRing API
        const secretKey = crypto.getRandomValues(new Uint8Array(32));
        const keypair = await mgr!.keyring.addKeyPair(secretKey);
        expect(keypair.publicKeyHex).toBeDefined();

        // Create a sender wallet with cashu-ts
        const senderWallet = new CashuWallet(new CashuMint(mintUrl));

        // Fund the sender wallet
        const senderQuote = await senderWallet.createMintQuote(100);
        let quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofs(100, senderQuote.quote);
        expect(senderProofs.length).toBeGreaterThan(0);

        // Create P2PK locked token using cashu-ts send method with pubkey
        const sendAmount = 50;
        const { send: p2pkProofs } = await senderWallet.send(sendAmount, senderProofs, {
          pubkey: keypair.publicKeyHex,
        });

        expect(p2pkProofs.length).toBeGreaterThan(0);

        // Verify the proofs are P2PK locked
        const firstProof = p2pkProofs[0];
        expect(firstProof?.secret).toBeDefined();
        const parsedSecret = JSON.parse(firstProof!.secret);
        expect(parsedSecret[0]).toBe('P2PK');
        expect(parsedSecret[1].data).toBe(keypair.publicKeyHex);

        // Create token
        const p2pkToken: Token = {
          mint: mintUrl,
          proofs: p2pkProofs,
        };

        // Get balance before receiving
        const balanceBefore = await mgr!.wallet.getBalances();
        const amountBefore = balanceBefore[mintUrl] || 0;

        // Receive the P2PK token - this should automatically sign it
        await mgr!.wallet.receive(p2pkToken);

        // Verify balance increased
        const balanceAfter = await mgr!.wallet.getBalances();
        const amountAfter = balanceAfter[mintUrl] || 0;
        expect(amountAfter).toBeGreaterThan(amountBefore);
        expect(amountAfter - amountBefore).toBeGreaterThanOrEqual(sendAmount - 10); // Allow for fees

        // Verify original P2PK proofs are now spent
        const proofStates = await senderWallet.checkProofsStates(p2pkProofs);
        const allSpent = proofStates.every((p: any) => p.state === 'SPENT');
        expect(allSpent).toBe(true);
      });

      it('should receive P2PK locked token created with cashu-ts', async () => {
        // Generate a keypair using the KeyRing API
        const keypair = await mgr!.keyring.generateKeyPair();
        expect(keypair.publicKeyHex).toBeDefined();
        expect('secretKey' in keypair).toBe(false);

        // Create a sender wallet with cashu-ts
        const senderWallet = new CashuWallet(new CashuMint(mintUrl));

        // Fund the sender wallet
        const senderQuote = await senderWallet.createMintQuote(100);
        let quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofs(100, senderQuote.quote);
        expect(senderProofs.length).toBeGreaterThan(0);

        // Create P2PK locked token using cashu-ts send method with pubkey
        const sendAmount = 50;
        const { send: p2pkProofs } = await senderWallet.send(sendAmount, senderProofs, {
          pubkey: keypair.publicKeyHex,
        });

        expect(p2pkProofs.length).toBeGreaterThan(0);

        // Verify the proofs are P2PK locked
        const firstProof = p2pkProofs[0];
        expect(firstProof?.secret).toBeDefined();
        const parsedSecret = JSON.parse(firstProof!.secret);
        expect(parsedSecret[0]).toBe('P2PK');
        expect(parsedSecret[1].data).toBe(keypair.publicKeyHex);

        // Create token
        const p2pkToken: Token = {
          mint: mintUrl,
          proofs: p2pkProofs,
        };

        // Get balance before receiving
        const balanceBefore = await mgr!.wallet.getBalances();
        const amountBefore = balanceBefore[mintUrl] || 0;

        // Receive the P2PK token - this should automatically sign it
        await mgr!.wallet.receive(p2pkToken);

        // Verify balance increased
        const balanceAfter = await mgr!.wallet.getBalances();
        const amountAfter = balanceAfter[mintUrl] || 0;
        expect(amountAfter).toBeGreaterThan(amountBefore);
        expect(amountAfter - amountBefore).toBeGreaterThanOrEqual(sendAmount - 10); // Allow for fees

        // Verify original P2PK proofs are now spent
        const proofStates = await senderWallet.checkProofsStates(p2pkProofs);
        const allSpent = proofStates.every((p: any) => p.state === 'SPENT');
        expect(allSpent).toBe(true);
      });

      it('should fail to receive P2PK token without the private key', async () => {
        // Create a sender wallet with cashu-ts
        const senderSeed = crypto.getRandomValues(new Uint8Array(64));
        const senderWallet = new CashuWallet(new CashuMint(mintUrl), {
          bip39seed: senderSeed,
        });

        // Fund the sender wallet
        const senderQuote = await senderWallet.createMintQuote(100);
        let quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofs(100, senderQuote.quote, { counter: 0 });

        // Lock to a public key we don't have the private key for
        const fakePublicKey = '02' + '11'.repeat(31);
        const { send: p2pkProofs } = await senderWallet.send(50, senderProofs, {
          pubkey: fakePublicKey,
        });

        const p2pkToken: Token = {
          mint: mintUrl,
          proofs: p2pkProofs,
        };

        // Should fail because we don't have the private key
        await expect(mgr!.wallet.receive(p2pkToken)).rejects.toThrow();
      });

      it('should handle multiple P2PK locked proofs in one token', async () => {
        // Generate a keypair using the KeyRing API
        const keypair = await mgr!.keyring.generateKeyPair();
        const keypair2 = await mgr!.keyring.generateKeyPair();

        // Create sender wallet
        const senderWallet = new CashuWallet(new CashuMint(mintUrl));
        await senderWallet.loadMint();
        const keyset = await senderWallet.getActiveKeyset(senderWallet.keysets);

        // Fund sender with more amount
        const senderQuote = await senderWallet.createMintQuote(200);
        let quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuote(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofs(200, senderQuote.quote);
        const outputData = [
          OutputData.createSingleP2PKData({ pubkey: keypair.publicKeyHex }, 32, keyset.id),
          OutputData.createSingleP2PKData({ pubkey: keypair2.publicKeyHex }, 32, keyset.id),
        ];

        const keepFactory: OutputDataFactory = (a, k) => OutputData.createSingleRandomData(a, k.id);
        // Create P2PK token with multiple proofs
        const { send: p2pkProofs } = await senderWallet.send(64, senderProofs, {
          outputData: { keep: keepFactory, send: outputData },
        });

        // Should have multiple proofs for 100 sats
        expect(p2pkProofs.length).toBeGreaterThan(1);

        const p2pkToken: Token = {
          mint: mintUrl,
          proofs: p2pkProofs,
        };

        const balanceBefore = await mgr!.wallet.getBalances();
        const amountBefore = balanceBefore[mintUrl] || 0;

        // Receive all P2PK proofs at once
        await mgr!.wallet.receive(p2pkToken);

        const balanceAfter = await mgr!.wallet.getBalances();
        const amountAfter = balanceAfter[mintUrl] || 0;
        expect(amountAfter - amountBefore).toBeGreaterThanOrEqual(50); // Allow for fees
      });
    });

    describe('Wallet Restore', () => {
      it('should sweep a mint from another seed', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          // Create a separate wallet with a different seed that has funds
          const toBeSweptSeed = crypto.getRandomValues(new Uint8Array(64));
          const baseWallet = new CashuWallet(new CashuMint(mintUrl), {
            bip39seed: toBeSweptSeed,
          });

          // Create and pay mint quote
          const quote = await baseWallet.createMintQuote(100);

          // Wait for quote to be marked as paid
          let quoteState = await baseWallet.checkMintQuote(quote.quote);
          let attempts = 0;
          while (quoteState.state !== 'PAID' && attempts <= 3) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            quoteState = await baseWallet.checkMintQuote(quote.quote);
            attempts++;
          }
          // Mint proofs to the wallet being swept
          const toBeSweptProofs = await baseWallet.mintProofs(100, quote.quote, { counter: 0 });
          expect(toBeSweptProofs.length).toBeGreaterThan(0);

          // Verify balance before sweep
          const balanceBefore = await mgr.wallet.getBalances();
          expect(balanceBefore[mintUrl] || 0).toBe(0);

          // Listen for proofs:saved events
          const sweepEvents: any[] = [];
          const unsubscribe = mgr!.on('proofs:saved', (payload) => {
            if (payload.mintUrl === mintUrl) {
              sweepEvents.push(payload);
            }
          });

          // Perform the sweep
          await mgr.wallet.sweep(mintUrl, toBeSweptSeed);

          // Verify balance increased (allowing for fees)
          const balanceAfter = await mgr.wallet.getBalances();
          expect(balanceAfter[mintUrl] || 0).toBeGreaterThan(0);
          expect(balanceAfter[mintUrl] || 0).toBeLessThanOrEqual(100);
          expect(balanceAfter[mintUrl] || 0).toBeGreaterThanOrEqual(95); // Allow up to 5 sat fee

          // Verify mint was added and trusted
          const isTrusted = await mgr.mint.isTrustedMint(mintUrl);
          expect(isTrusted).toBe(true);

          // Verify events were emitted
          expect(sweepEvents.length).toBeGreaterThan(0);

          // Verify original proofs are now spent
          const originalProofStates = await baseWallet.checkProofsStates(toBeSweptProofs);
          const allSpent = originalProofStates.every((p: any) => p.state === 'SPENT');
          expect(allSpent).toBe(true);

          unsubscribe();
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });
    });

    describe('Payment Requests', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
        });

        await mgr.mint.addMint(mintUrl, { trusted: true });

        // Fund the wallet
        const quote = await mgr.quotes.createMintQuote(mintUrl, 200);
        await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      });

      afterEach(async () => {
        if (repositoriesDispose) {
          await repositoriesDispose();
          repositoriesDispose = undefined;
        }
      });

      it('should read an inband payment request', async () => {
        const pr = new PaymentRequest(
          [], // empty transport = inband
          'test-request-id',
          50,
          'sat',
          [mintUrl],
          'Test payment',
        );
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);

        expect(prepared.transport.type).toBe('inband');
        expect(prepared.amount).toBe(50);
        expect(prepared.mints).toContain(mintUrl);
      });

      it('should read an HTTP POST payment request', async () => {
        const targetUrl = 'https://receiver.example.com/callback';
        const pr = new PaymentRequest(
          [{ type: PaymentRequestTransportType.POST, target: targetUrl }],
          'test-request-id-2',
          75,
          'sat',
          [mintUrl],
          'HTTP payment',
        );
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);

        expect(prepared.transport.type).toBe('http');
        if (prepared.transport.type === 'http') {
          expect(prepared.transport.url).toBe(targetUrl);
        }
        expect(prepared.amount).toBe(75);
      });

      it('should read a payment request without amount', async () => {
        const pr = new PaymentRequest(
          [],
          'test-request-no-amount',
          undefined, // no amount
          'sat',
          [mintUrl],
        );
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);

        expect(prepared.transport.type).toBe('inband');
        expect(prepared.amount).toBe(undefined);
      });

      it('should handle inband payment request with amount in request', async () => {
        const pr = new PaymentRequest([], 'inband-with-amount', 30, 'sat', [mintUrl]);
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);
        expect(prepared.transport.type).toBe('inband');

        const balanceBefore = await mgr!.wallet.getBalances();
        const amountBefore = balanceBefore[mintUrl] || 0;

        let receivedToken: Token | undefined;
        if (prepared.transport.type === 'inband') {
          await mgr!.wallet.handleInbandPaymentRequest(mintUrl, prepared, async (token) => {
            receivedToken = token;
          });
        }

        expect(receivedToken).toBeDefined();
        expect(receivedToken!.mint).toBe(mintUrl);
        expect(receivedToken!.proofs.length).toBeGreaterThan(0);

        const tokenAmount = receivedToken!.proofs.reduce((sum, p) => sum + p.amount, 0);
        expect(tokenAmount).toBeGreaterThanOrEqual(30);

        // Balance should have decreased
        const balanceAfter = await mgr!.wallet.getBalances();
        const amountAfter = balanceAfter[mintUrl] || 0;
        expect(amountAfter).toBeLessThan(amountBefore);
      });

      it('should handle inband payment request with amount as parameter', async () => {
        const pr = new PaymentRequest(
          [],
          'inband-no-amount',
          undefined, // no amount in request
          'sat',
          [mintUrl],
        );
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);
        expect(prepared.transport.type).toBe('inband');
        expect(prepared.amount).toBe(undefined);

        let receivedToken: Token | undefined;
        if (prepared.transport.type === 'inband') {
          await mgr!.wallet.handleInbandPaymentRequest(
            mintUrl,
            prepared,
            async (token) => {
              receivedToken = token;
            },
            25, // amount as parameter
          );
        }

        expect(receivedToken).toBeDefined();
        expect(receivedToken!.mint).toBe(mintUrl);

        const tokenAmount = receivedToken!.proofs.reduce((sum, p) => sum + p.amount, 0);
        expect(tokenAmount).toBeGreaterThanOrEqual(25);
      });

      it('should throw if mint is not in allowed mints list', async () => {
        const otherMintUrl = 'https://other-mint.example.com';
        const pr = new PaymentRequest(
          [],
          'wrong-mint-request',
          50,
          'sat',
          [otherMintUrl], // only allows other mint
        );
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);

        if (prepared.transport.type === 'inband') {
          await expect(
            mgr!.wallet.handleInbandPaymentRequest(mintUrl, prepared, async () => {}),
          ).rejects.toThrow();
        }
      });

      it('should throw if amount is missing', async () => {
        const pr = new PaymentRequest([], 'no-amount-request', undefined, 'sat', [mintUrl]);
        const encoded = pr.toEncodedRequest();

        const prepared = await mgr!.wallet.readPaymentRequest(encoded);

        if (prepared.transport.type === 'inband') {
          // Not providing amount when request doesn't have one should throw
          await expect(
            mgr!.wallet.handleInbandPaymentRequest(mintUrl, prepared, async () => {}),
          ).rejects.toThrow();
        }
      });

      it('should throw for unsupported transport (nostr)', async () => {
        const pr = new PaymentRequest(
          [{ type: PaymentRequestTransportType.NOSTR, target: 'npub1...' }],
          'nostr-request',
          50,
          'sat',
          [mintUrl],
        );
        const encoded = pr.toEncodedRequest();

        await expect(mgr!.wallet.readPaymentRequest(encoded)).rejects.toThrow();
      });

      it('should complete full payment request flow with token reuse', async () => {
        // Create inband payment request
        const pr = new PaymentRequest([], 'full-flow-test', 40, 'sat', [mintUrl]);
        const encoded = pr.toEncodedRequest();

        // Read the payment request
        const prepared = await mgr!.wallet.readPaymentRequest(encoded);
        expect(prepared.transport.type).toBe('inband');

        // Handle the payment request
        let sentToken: Token | undefined;
        if (prepared.transport.type === 'inband') {
          await mgr!.wallet.handleInbandPaymentRequest(mintUrl, prepared, async (token) => {
            sentToken = token;
          });
        }

        expect(sentToken).toBeDefined();

        // The token should be receivable (simulate receiver getting the token)
        const balanceBefore = await mgr!.wallet.getBalances();
        await mgr!.wallet.receive(sentToken!);
        const balanceAfter = await mgr!.wallet.getBalances();

        // Balance should increase after receiving
        expect((balanceAfter[mintUrl] || 0) - (balanceBefore[mintUrl] || 0)).toBeGreaterThan(0);
      });
    });
  });
}
