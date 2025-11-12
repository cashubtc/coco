import type { Repositories, Manager, Logger } from 'coco-cashu-core';
import { initializeCoco, getEncodedToken } from 'coco-cashu-core';
import { CashuMint, CashuWallet, type Token } from '@cashu/cashu-ts';

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
        const invoice =
          'lnbc10n1p5sm5j8pp5ud6a93e5cah2dt6psv6fxg480ff9lxp7lq0c5q0c2nvh0g4gxhzsdqqcqzzsxqyz5vqrzjqvueefmrckfdwyyu39m0lf24sqzcr9vcrmxrvgfn6empxz7phrjxvrttncqq0lcqqyqqqqlgqqqqqqgq2qsp5mvpekp0pkkzk8svnl5j20ryuc8uucnhhjfka9dztw8aqhcmhq22q9qxpqysgqerja5tgvsjs4wlywh7uzte53pcxz87stnht783d4athc28fq25hxy767dx9w7dgxszglk697npldtn654cle58wvd9dxglsd0p0mgmgqqk4wnx';
        const meltQuote = await mgr!.quotes.createMeltQuote(mintUrl, invoice);

        expect(meltQuote.quote).toBeDefined();
        expect(meltQuote.amount).toBeGreaterThan(0);

        await eventPromise;
      });

      it('should pay a melt quote (may skip swap if exact amount)', async () => {
        const invoice =
          'lnbc20n1p5sm5j3pp509qdavqadxfwmggservdg047eylgy9ry8k96lklgvgdmnxxwv7yqdqqcqzzsxqyz5vqrzjqvueefmrckfdwyyu39m0lf24sqzcr9vcrmxrvgfn6empxz7phrjxvrttncqq0lcqqyqqqqlgqqqqqqgq2qsp5nahghzy767gll8s98k9ccm83sclp8t5ftxnmfc3gspamyt30tphq9qxpqysgqh5655ecvl2qfxp8spd90ekn4jrxt26yx90uwqdnnw366wtmknufkwtypjv0v0mwguxj2hvdyr8ltzf4fs67ez9953rsqz5quevl2ntsp4fngdc';
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
  });
}
