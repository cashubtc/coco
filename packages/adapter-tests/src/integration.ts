import type { Repositories, Manager, Logger } from 'coco-cashu-core';
import { initializeCoco, getEncodedToken } from 'coco-cashu-core';
import {
  Mint,
  Wallet,
  OutputData,
  type OutputConfig,
  PaymentRequest,
  PaymentRequestTransportType,
  type MintKeys,
  type Token,
  type HasKeysetKeys,
} from '@cashu/cashu-ts';
import { createFakeInvoice } from 'fake-bolt11';

export type OutputDataFactory = (amount: number, keys: MintKeys | HasKeysetKeys) => OutputData;

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

          const quote = await mgr!.quotes.createMintQuote(mintUrl, 50);
          await mgr!.quotes.redeemMintQuote(mintUrl, quote.quote);
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
        const sendPendingPromise = new Promise((resolve) => {
          mgr!.once('send:pending', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            expect(payload.token.proofs.length).toBeGreaterThan(0);
            const tokenAmount = payload.token.proofs.reduce((sum, p) => sum + p.amount, 0);
            expect(tokenAmount).toBeGreaterThanOrEqual(sendAmount);
            resolve(payload);
          });
        });

        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        const { token } = await mgr!.send.executePreparedSend(preparedSend.id);
        await sendPendingPromise;

        expect(token.mint).toBe(mintUrl);
        expect(token.proofs.length).toBeGreaterThan(0);

        const balanceAfterSend = await mgr!.wallet.getBalances();
        const amountAfterSend = balanceAfterSend[mintUrl] || 0;
        expect(amountAfterSend).toBeLessThan(initialAmount);
      });

      it('should emit send:prepared and send:pending events', async () => {
        const sendAmount = 30;
        let preparedOperationId: string | undefined;

        const preparedPromise = new Promise((resolve) => {
          mgr!.once('send:prepared', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            expect(payload.operationId).toBeDefined();
            expect(payload.operation.state).toBe('prepared');
            preparedOperationId = payload.operationId;
            resolve(payload);
          });
        });

        const pendingPromise = new Promise((resolve) => {
          mgr!.once('send:pending', (payload) => {
            expect(payload.mintUrl).toBe(mintUrl);
            expect(payload.operationId).toBeDefined();
            expect(payload.operation.state).toBe('pending');
            expect(payload.token.proofs.length).toBeGreaterThan(0);
            resolve(payload);
          });
        });

        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        await preparedPromise;
        await pendingPromise;
      });

      it('should receive tokens and update balance', async () => {
        const initialBalance = await mgr!.wallet.getBalances();
        const initialAmount = initialBalance[mintUrl] || 0;

        const sendAmount = 30;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        const { token } = await mgr!.send.executePreparedSend(preparedSend.id);

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
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        const { token } = await mgr!.send.executePreparedSend(preparedSend.id);

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
          const preparedSend = await mgr!.send.prepareSend(mintUrl, amount);
          const { token } = await mgr!.send.executePreparedSend(preparedSend.id);
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

    describe('Proof State Checks', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
          watchers: {
            proofStateWatcher: { disabled: true },
          },
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

      it('should mark inflight proofs as spent on manual check', async () => {
        const sendAmount = 25;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        const { token } = await mgr!.send.executePreparedSend(preparedSend.id);

        await mgr!.wallet.receive(token);

        const proofRepository = (mgr as any).proofRepository as Repositories['proofRepository'];
        const proofService = (mgr as any).proofService as {
          checkInflightProofs: () => Promise<void>;
        };

        const beforeStates = await Promise.all(
          token.proofs.map((proof) => proofRepository.getProofBySecret(mintUrl, proof.secret)),
        );
        const inflightCount = beforeStates.filter((proof) => proof?.state === 'inflight').length;
        expect(inflightCount).toBeGreaterThan(0);

        await proofService.checkInflightProofs();

        const afterStates = await Promise.all(
          token.proofs.map((proof) => proofRepository.getProofBySecret(mintUrl, proof.secret)),
        );
        const spentCount = afterStates.filter((proof) => proof?.state === 'spent').length;
        expect(spentCount).toBe(token.proofs.length);
      }, 10000);
    });

    describe('Melt Quote Workflow', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;
      let repositories: Repositories | undefined;

      beforeEach(async () => {
        const created = await createRepositories();
        repositories = created.repositories;
        repositoriesDispose = created.dispose;
        mgr = await initializeCoco({
          repo: created.repositories,
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
        repositories = undefined;
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

        const stored = await repositories!.meltQuoteRepository.getMeltQuote(
          mintUrl,
          meltQuote.quote,
        );
        expect(stored).toBeDefined();
        expect(stored?.quote).toBe(meltQuote.quote);
        expect(stored?.mintUrl).toBe(mintUrl);

        await eventPromise;
      });

      it('should reject invalid melt quote parameters', async () => {
        const invoice = createFakeInvoice(10);
        await expect(mgr!.quotes.createMeltQuote('', invoice)).rejects.toThrow();
        await expect(mgr!.quotes.createMeltQuote(mintUrl, '')).rejects.toThrow();
        await expect(mgr!.quotes.payMeltQuote('', 'quote-id')).rejects.toThrow();
        await expect(mgr!.quotes.payMeltQuote(mintUrl, '')).rejects.toThrow();
      });

      it('should reject melt quote creation for untrusted mint', async () => {
        await mgr!.mint.untrustMint(mintUrl);
        const invoice = createFakeInvoice(15);
        await expect(mgr!.quotes.createMeltQuote(mintUrl, invoice)).rejects.toThrow();
      });

      it('should reject paying a missing melt quote', async () => {
        await expect(mgr!.quotes.payMeltQuote(mintUrl, 'missing-quote')).rejects.toThrow();
      });

      it('should reject paying melt quote for untrusted mint', async () => {
        const invoice = createFakeInvoice(30);
        const meltQuote = await mgr!.quotes.createMeltQuote(mintUrl, invoice);
        await mgr!.mint.untrustMint(mintUrl);
        await expect(mgr!.quotes.payMeltQuote(mintUrl, meltQuote.quote)).rejects.toThrow();
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

        const storedQuote = await repositories!.meltQuoteRepository.getMeltQuote(
          mintUrl,
          meltQuote.quote,
        );
        expect(storedQuote?.state).toBe('PAID');

        const balanceAfter = await mgr!.wallet.getBalances();
        const balanceAfterAmount = balanceAfter[mintUrl] || 0;
        const amountWithFee = meltQuote.amount + meltQuote.fee_reserve;

        // Balance should decrease by at least the amount + fee
        expect(balanceAfterAmount).toBeLessThanOrEqual(balanceBeforeAmount - amountWithFee);
      });

      it('should execute a melt operation by quote params', async () => {
        const invoice = createFakeInvoice(25);
        const prepared = await mgr!.quotes.prepareMeltBolt11(mintUrl, invoice);

        expect(prepared.quoteId).toBeDefined();

        const stored = await repositories!.meltOperationRepository.getByQuoteId(
          mintUrl,
          prepared.quoteId,
        );
        expect(stored).toHaveLength(1);
        expect(stored[0]!.state).toBe('prepared');

        const executed = await mgr!.quotes.executeMeltByQuote(mintUrl, prepared.quoteId);

        expect(executed).toBeDefined();
        expect(executed?.mintUrl).toBe(mintUrl);
        expect(executed?.quoteId).toBe(prepared.quoteId);

        const operationAfterExecute = await repositories!.meltOperationRepository.getById(
          executed!.id,
        );
        expect(operationAfterExecute).toBeDefined();
        expect(operationAfterExecute!.state).toBe(executed!.state);

        if (executed?.state === 'pending') {
          let pendingResult = await mgr!.quotes.checkPendingMeltByQuote(mintUrl, prepared.quoteId);
          expect(pendingResult).toBeDefined();

          const operationAfterCheck = await repositories!.meltOperationRepository.getById(
            executed!.id,
          );
          expect(operationAfterCheck).toBeDefined();

          if (pendingResult === 'stay_pending') {
            pendingResult = await mgr!.quotes.checkPendingMeltByQuote(mintUrl, prepared.quoteId);
          }

          const operationAfterRetry = await repositories!.meltOperationRepository.getById(
            executed!.id,
          );
          expect(operationAfterRetry).toBeDefined();

          if (pendingResult === 'finalize') {
            expect(operationAfterRetry!.state).toBe('finalized');
          } else if (pendingResult === 'rollback') {
            expect(operationAfterRetry!.state).toBe('rolled_back');
          } else {
            expect(operationAfterRetry!.state).toBe('pending');
          }
        }
      });

      it('should return null when executing or checking missing quote', async () => {
        const missingExecute = await mgr!.quotes.executeMeltByQuote(mintUrl, 'missing-quote');
        expect(missingExecute).toBe(null);

        const missingCheck = await mgr!.quotes.checkPendingMeltByQuote(mintUrl, 'missing-quote');
        expect(missingCheck).toBe(null);
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

      it('should create send history entry with state when send operation is executed', async () => {
        const sendAmount = 20;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        // Wait for events to settle
        await new Promise((resolve) => setTimeout(resolve, 100));

        const history = await mgr!.history.getPaginatedHistory(0, 10);
        const sendEntry = history.find((e) => e.type === 'send')!;

        expect(sendEntry).toBeDefined();
        expect(sendEntry!.type).toBe('send');
        if (sendEntry!.type === 'send') {
          expect(sendEntry.operationId).toBeDefined();
          expect(sendEntry.state).toBe('pending');
          expect(sendEntry.amount).toBe(sendAmount);
          expect(sendEntry.token).toBeDefined();
          expect(sendEntry.token!.proofs.length).toBeGreaterThan(0);
        }
      });

      it('should emit history:updated events for send state changes', async () => {
        const historyEvents: any[] = [];
        const unsubscribe = mgr!.on('history:updated', (payload) => {
          if (payload.entry.type === 'send') {
            historyEvents.push(payload);
          }
        });

        const sendAmount = 15;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        // Wait for events to settle
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Should have at least 2 history events: prepared and pending
        expect(historyEvents.length).toBeGreaterThanOrEqual(2);

        // First event should be prepared state
        const preparedEvent = historyEvents.find(
          (e) => e.entry.type === 'send' && e.entry.state === 'prepared',
        );
        expect(preparedEvent).toBeDefined();

        // Second event should be pending state with token
        const pendingEvent = historyEvents.find(
          (e) => e.entry.type === 'send' && e.entry.state === 'pending',
        );
        expect(pendingEvent).toBeDefined();
        if (pendingEvent && pendingEvent.entry.type === 'send') {
          expect(pendingEvent.entry.token).toBeDefined();
        }

        unsubscribe();
      });
    });

    describe('Send Operations API', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
          watchers: {
            mintQuoteWatcher: {
              disabled: true,
            },
          },
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

      it('should get pending send operations', async () => {
        // Initially no pending operations
        const pendingBefore = await mgr!.send.getPendingOperations();
        expect(Array.isArray(pendingBefore)).toBe(true);

        // Send tokens to create a pending operation
        const sendAmount = 30;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        const pendingAfter = await mgr!.send.getPendingOperations();
        expect(pendingAfter.length).toBeGreaterThan(0);

        const operation = pendingAfter[0];
        expect(operation?.state).toBe('pending');
        expect(operation?.mintUrl).toBe(mintUrl);
      });

      it('should get operation by ID', async () => {
        let operationId: string | undefined;

        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const sendAmount = 25;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        expect(operationId).toBeDefined();

        const operation = await mgr!.send.getOperation(operationId!);
        expect(operation).toBeDefined();
        expect(operation!.id).toBe(operationId);
        expect(operation!.state).toBe('pending');
      });

      it('should rollback a pending send operation', async () => {
        let operationId: string | undefined;

        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const balanceBefore = await mgr!.wallet.getBalances();
        const amountBefore = balanceBefore[mintUrl] || 0;

        const sendAmount = 40;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        const balanceAfterSend = await mgr!.wallet.getBalances();
        const amountAfterSend = balanceAfterSend[mintUrl] || 0;

        // Balance should be lower after send
        expect(amountAfterSend).toBeLessThan(amountBefore);

        // Listen for rollback event
        const rolledBackPromise = new Promise((resolve) => {
          mgr!.once('send:rolled-back', (payload) => {
            expect(payload.operationId).toBe(operationId);
            expect(payload.operation.state).toBe('rolled_back');
            resolve(payload);
          });
        });

        // Rollback the operation
        await mgr!.send.rollback(operationId!);
        await rolledBackPromise;

        // Operation should be rolled back
        const operation = await mgr!.send.getOperation(operationId!);
        expect(operation!.state).toBe('rolled_back');

        // Balance should be restored (minus fees for swap if any)
        const balanceAfterRollback = await mgr!.wallet.getBalances();
        const amountAfterRollback = balanceAfterRollback[mintUrl] || 0;
        expect(amountAfterRollback).toBeGreaterThan(amountAfterSend);
      });

      it('should update history state to rolledBack on rollback', async () => {
        let operationId: string | undefined;

        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const sendAmount = 35;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        await mgr!.send.executePreparedSend(preparedSend.id);

        // Wait for history to be updated
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Check initial history state
        let history = await mgr!.history.getPaginatedHistory(0, 10);
        let sendEntry = history.find(
          (e) => e.type === 'send' && (e as any).operationId === operationId,
        );
        expect(sendEntry).toBeDefined();
        expect((sendEntry as any).state).toBe('pending');

        // Rollback
        await mgr!.send.rollback(operationId!);

        // Wait for history to be updated
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Check updated history state
        history = await mgr!.history.getPaginatedHistory(0, 10);
        sendEntry = history.find(
          (e) => e.type === 'send' && (e as any).operationId === operationId,
        );
        expect(sendEntry).toBeDefined();
        expect((sendEntry as any).state).toBe('rolledBack');
      });

      it('should finalize a pending send operation when proofs are spent', async () => {
        let operationId: string | undefined;

        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const sendAmount = 20;
        const preparedSend = await mgr!.send.prepareSend(mintUrl, sendAmount);
        const { token } = await mgr!.send.executePreparedSend(preparedSend.id);

        // Receive the token (simulates recipient claiming)
        await mgr!.wallet.receive(token);

        // Wait for proof state watcher to detect spent proofs and finalize
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Operation should be finalized
        const operation = await mgr!.send.getOperation(operationId!);
        expect(operation!.state).toBe('finalized');

        // Check history state
        const history = await mgr!.history.getPaginatedHistory(0, 10);
        const sendEntry = history.find(
          (e) => e.type === 'send' && (e as any).operationId === operationId,
        );
        expect(sendEntry).toBeDefined();
        expect((sendEntry as any).state).toBe('finalized');
      }, 10000);

      it('should recover pending operations on startup', async () => {
        // Create a pending operation
        let operationId: string | undefined;
        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const preparedSend = await mgr!.send.prepareSend(mintUrl, 25);
        await mgr!.send.executePreparedSend(preparedSend.id);

        // Verify operation is pending
        const operationBefore = await mgr!.send.getOperation(operationId!);
        expect(operationBefore!.state).toBe('pending');

        // Manually call recovery (simulates restart)
        await mgr!.send.recoverPendingOperations();

        // Operation should still exist (recovery handles it)
        const operationAfter = await mgr!.send.getOperation(operationId!);
        expect(operationAfter).toBeDefined();
      });
    });

    describe('Send Operation Locking', () => {
      let repositoriesDispose: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        const { repositories, dispose } = await createRepositories();
        repositoriesDispose = dispose;
        mgr = await initializeCoco({
          repo: repositories,
          seedGetter,
          logger,
          watchers: {
            mintQuoteWatcher: {
              disabled: true,
            },
          },
        });

        await mgr.mint.addMint(mintUrl, { trusted: true });

        const quote = await mgr.quotes.createMintQuote(mintUrl, 300);
        await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      });

      afterEach(async () => {
        if (repositoriesDispose) {
          await repositoriesDispose();
          repositoriesDispose = undefined;
        }
      });

      it('should prevent concurrent execution of executePreparedSend on same operation', async () => {
        // Prepare a send operation
        const prepared = await mgr!.send.prepareSend(mintUrl, 30);
        expect(prepared.state).toBe('prepared');

        // Execute once - should work
        const { operation } = await mgr!.send.executePreparedSend(prepared.id);
        expect(operation.state).toBe('pending');

        // Second execute should fail because operation state is no longer 'prepared'
        await expect(mgr!.send.executePreparedSend(prepared.id)).rejects.toThrow();
      });

      it('should prevent concurrent rollback on same operation', async () => {
        // Send and capture operation ID
        let operationId: string | undefined;
        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const preparedSend = await mgr!.send.prepareSend(mintUrl, 40);
        await mgr!.send.executePreparedSend(preparedSend.id);
        expect(operationId).toBeDefined();

        // Start two rollbacks concurrently - second should fail
        const rollback1 = mgr!.send.rollback(operationId!);
        const rollback2 = mgr!.send.rollback(operationId!);

        // Wait for both to settle
        const results = await Promise.allSettled([rollback1, rollback2]);

        // One should succeed, one should fail
        const succeeded = results.filter((r) => r.status === 'fulfilled');
        const failed = results.filter((r) => r.status === 'rejected');

        expect(succeeded.length).toBe(1);
        expect(failed.length).toBe(1);

        // Verify it was an "already in progress" error
        const error = failed[0] as PromiseRejectedResult;
        expect(error.reason.message).toContain('already in progress');
      });

      it('should prevent concurrent finalize on same operation', async () => {
        // Send and capture operation ID
        let operationId: string | undefined;
        mgr!.once('send:pending', (payload) => {
          operationId = payload.operationId;
        });

        const preparedSend = await mgr!.send.prepareSend(mintUrl, 35);
        const { token } = await mgr!.send.executePreparedSend(preparedSend.id);
        expect(operationId).toBeDefined();

        // Receive the token to make proofs spent (so finalize can work)
        await mgr!.wallet.receive(token);

        // Wait a bit for proof state detection
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Start two finalizes concurrently - at most one should execute the main logic
        const finalize1 = mgr!.send.finalize(operationId!);
        const finalize2 = mgr!.send.finalize(operationId!);

        // Wait for both to settle
        const results = await Promise.allSettled([finalize1, finalize2]);

        // Due to idempotent pre-checks, both might succeed if first completes before second checks
        // But if they're truly concurrent, second should fail with "already in progress"
        // Either way, operation should be completed
        const operation = await mgr!.send.getOperation(operationId!);
        expect(operation!.state).toBe('finalized');
      });

      it('should prevent concurrent recoverPendingOperations calls', async () => {
        // Start two recovery processes concurrently
        const recovery1 = mgr!.send.recoverPendingOperations();
        const recovery2 = mgr!.send.recoverPendingOperations();

        // Wait for both to settle
        const results = await Promise.allSettled([recovery1, recovery2]);

        // One should succeed, one should fail
        const succeeded = results.filter((r) => r.status === 'fulfilled');
        const failed = results.filter((r) => r.status === 'rejected');

        expect(succeeded.length).toBe(1);
        expect(failed.length).toBe(1);

        // Verify it was an "already in progress" error
        const error = failed[0] as PromiseRejectedResult;
        expect(error.reason.message).toContain('already in progress');
      });

      it('should report correct lock status via isOperationLocked', async () => {
        // Prepare a send operation
        const prepared = await mgr!.send.prepareSend(mintUrl, 25);

        // Before execution starts, operation should not be locked
        expect(mgr!.send.isOperationLocked(prepared.id)).toBe(false);

        // Start a slow operation by doing execute in background
        let executeStarted = false;
        let executeFinished = false;

        const executePromise = (async () => {
          executeStarted = true;
          await mgr!.send.executePreparedSend(prepared.id);
          executeFinished = true;
        })();

        // Give a small delay for execute to start (though JS is single-threaded,
        // the lock should be acquired synchronously at the start of execute)
        await new Promise((resolve) => setTimeout(resolve, 10));

        // After execute completes, operation should no longer be locked
        await executePromise;
        expect(executeFinished).toBe(true);
        expect(mgr!.send.isOperationLocked(prepared.id)).toBe(false);
      });

      it('should report correct recovery status via isRecoveryInProgress', async () => {
        // Before recovery starts, should not be in progress
        expect(mgr!.send.isRecoveryInProgress()).toBe(false);

        // Start recovery
        const recoveryPromise = mgr!.send.recoverPendingOperations();

        // Give a small delay for recovery to acquire lock
        await new Promise((resolve) => setTimeout(resolve, 10));

        // After recovery completes, should no longer be in progress
        await recoveryPromise;
        expect(mgr!.send.isRecoveryInProgress()).toBe(false);
      });

      it('should allow sequential operations on same operation ID after first completes', async () => {
        // Prepare and execute
        const prepared = await mgr!.send.prepareSend(mintUrl, 20);
        const { operation } = await mgr!.send.executePreparedSend(prepared.id);

        // Rollback should work (operation is now unlocked)
        await mgr!.send.rollback(operation.id);

        // Verify rolled back
        const finalOp = await mgr!.send.getOperation(operation.id);
        expect(finalOp!.state).toBe('rolled_back');
      });

      it('should not affect different operations when one is locked', async () => {
        // Prepare two operations
        const prepared1 = await mgr!.send.prepareSend(mintUrl, 15);
        const prepared2 = await mgr!.send.prepareSend(mintUrl, 15);

        // Execute both - they have different IDs so both should work
        const [result1, result2] = await Promise.all([
          mgr!.send.executePreparedSend(prepared1.id),
          mgr!.send.executePreparedSend(prepared2.id),
        ]);

        expect(result1.operation.state).toBe('pending');
        expect(result2.operation.state).toBe('pending');
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
          const savedProofs: unknown[] = [];
          const unsubStateChange = mgr.on('proofs:state-changed', (payload) => {
            stateChanges.push(payload);
          });
          const unsubSaved = mgr.on('proofs:saved', (payload) => {
            savedProofs.push(payload);
          });

          const preparedSend = await mgr!.send.prepareSend(mintUrl, 50);
          await mgr!.send.executePreparedSend(preparedSend.id);

          await new Promise((resolve) => setTimeout(resolve, 500));

          expect(stateChanges.length).toBeGreaterThan(0);
          const spentChange = stateChanges.find(
            (p: any) => p.mintUrl === mintUrl && p.state === 'spent',
          );
          expect(spentChange).toBeDefined();

          // Inflight proofs can come from either:
          // 1. proofs:state-changed with state='inflight' (exact match case)
          // 2. proofs:saved with inflight proofs (swap case)
          const inflightStateChange = stateChanges.find(
            (p: any) => p.mintUrl === mintUrl && p.state === 'inflight',
          );
          const inflightSaved = savedProofs.find(
            (p: any) =>
              p.mintUrl === mintUrl && p.proofs?.some((proof: any) => proof.state === 'inflight'),
          );
          expect(inflightStateChange || inflightSaved).toBeDefined();

          unsubStateChange();
          unsubSaved();
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

      it('should bootstrap inflight proof watchers on restart when enabled', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
            watchers: {
              mintQuoteWatcher: { disabled: true },
              proofStateWatcher: { disabled: true },
            },
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });

          const quote = await mgr.quotes.createMintQuote(mintUrl, 200);
          await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

          let operationId: string | undefined;
          const pendingPromise = new Promise((resolve) => {
            mgr!.once('send:pending', (payload) => {
              operationId = payload.operationId;
              resolve(payload);
            });
          });

          const preparedSend = await mgr!.send.prepareSend(mintUrl, 20);
          const { token } = await mgr!.send.executePreparedSend(preparedSend.id);
          await pendingPromise;

          const pendingOperation = await mgr!.send.getOperation(operationId!);
          expect(pendingOperation!.state).toBe('pending');

          await mgr.pauseSubscriptions();
          await mgr.dispose();
          mgr = undefined;

          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
            watchers: {
              mintQuoteWatcher: { disabled: true },
              proofStateWatcher: { watchExistingInflightOnStart: true },
            },
          });

          await mgr.mint.addMint(mintUrl, { trusted: true });
          await new Promise((resolve) => setTimeout(resolve, 500));

          await mgr!.wallet.receive(token);
          await new Promise((resolve) => setTimeout(resolve, 1500));

          const finalized = await mgr!.send.getOperation(operationId!);
          expect(finalized!.state).toBe('finalized');
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      }, 20000);
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
          const preparedSend1 = await mgr!.send.prepareSend(mintUrl, sendAmount);
          const { token: token1 } = await mgr!.send.executePreparedSend(preparedSend1.id);
          expect(token1.proofs.length).toBeGreaterThan(0);

          const balanceAfterSend = await mgr.wallet.getBalances();
          const amountAfterSend = balanceAfterSend[mintUrl] || 0;
          expect(amountAfterSend).toBeLessThan(balanceAfterMint[mintUrl] || 0);

          await mgr.wallet.receive(token1);

          const balanceAfterReceive = await mgr.wallet.getBalances();
          const amountAfterReceive = balanceAfterReceive[mintUrl] || 0;
          expect(amountAfterReceive).toBeGreaterThan(amountAfterSend);

          const preparedSend2 = await mgr!.send.prepareSend(mintUrl, 50);
          const { token: token2 } = await mgr!.send.executePreparedSend(preparedSend2.id);
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

      it('should preserve derivation index when adding a keypair that was previously generated', async () => {
        const { repositories, dispose } = await createRepositories();
        try {
          mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
            logger,
          });

          // Generate a keypair with dumpSecretKey to get the secret key
          const generated = await mgr.keyring.generateKeyPair(true);
          expect(generated.publicKeyHex).toBeDefined();
          expect(generated.secretKey).toBeDefined();

          // Retrieve and verify it has a derivation index
          const retrievedBefore = await mgr.keyring.getKeyPair(generated.publicKeyHex);
          expect(retrievedBefore).toBeDefined();
          expect(retrievedBefore?.derivationIndex).toBeDefined();
          const originalDerivationIndex = retrievedBefore!.derivationIndex;

          // Now add the same keypair via addKeyPair (which doesn't pass derivation index)
          await mgr.keyring.addKeyPair(generated.secretKey);

          // Retrieve again and verify derivation index is preserved
          const retrievedAfter = await mgr.keyring.getKeyPair(generated.publicKeyHex);
          expect(retrievedAfter).toBeDefined();
          expect(retrievedAfter?.derivationIndex).toBe(originalDerivationIndex);
        } finally {
          if (mgr) {
            await mgr.pauseSubscriptions();
            await mgr.dispose();
            mgr = undefined;
          }
          await dispose();
        }
      });

      it('should set derivation index when generating a keypair that was previously added', async () => {
        const { repositories: repo1, dispose: dispose1 } = await createRepositories();
        const { repositories: repo2, dispose: dispose2 } = await createRepositories();

        // Use same seed for both managers
        const sharedSeed = crypto.getRandomValues(new Uint8Array(64));
        const sharedSeedGetter = async () => sharedSeed;

        try {
          // First manager: generate a keypair to discover what the first derived key will be
          const mgr1 = await initializeCoco({
            repo: repo1,
            seedGetter: sharedSeedGetter,
            logger,
          });

          const derivedKp = await mgr1.keyring.generateKeyPair(true);
          expect(derivedKp.secretKey).toBeDefined();

          await mgr1.pauseSubscriptions();
          await mgr1.dispose();

          // Second manager: add the key first (without derivation index), then generate
          const mgr2 = await initializeCoco({
            repo: repo2,
            seedGetter: sharedSeedGetter,
            logger,
          });

          // Add the keypair first (no derivation index)
          const addedKp = await mgr2.keyring.addKeyPair(derivedKp.secretKey);
          expect(addedKp.publicKeyHex).toBe(derivedKp.publicKeyHex);

          // Verify it has no derivation index initially
          const retrievedBefore = await mgr2.keyring.getKeyPair(addedKp.publicKeyHex);
          expect(retrievedBefore).toBeDefined();
          expect(retrievedBefore?.derivationIndex).toBe(undefined);

          // Now generate - this will derive the same key and should set the derivation index
          const generatedKp = await mgr2.keyring.generateKeyPair();
          expect(generatedKp.publicKeyHex).toBe(derivedKp.publicKeyHex);

          // Verify derivation index is now set
          const retrievedAfter = await mgr2.keyring.getKeyPair(addedKp.publicKeyHex);
          expect(retrievedAfter).toBeDefined();
          expect(retrievedAfter?.derivationIndex).toBeDefined();

          await mgr2.pauseSubscriptions();
          await mgr2.dispose();
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
        const senderWallet = new Wallet(new Mint(mintUrl));
        await senderWallet.loadMint();

        // Fund the sender wallet
        const senderQuote = await senderWallet.createMintQuoteBolt11(100);
        let quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofsBolt11(100, senderQuote.quote);
        expect(senderProofs.length).toBeGreaterThan(0);

        // Create P2PK locked token using cashu-ts send method with pubkey
        const sendAmount = 50;
        const { send: p2pkProofs } = await senderWallet.ops
          .send(sendAmount, senderProofs)
          .asP2PK({ pubkey: keypair.publicKeyHex })
          .run();

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
        const senderWallet = new Wallet(new Mint(mintUrl));
        await senderWallet.loadMint();

        // Fund the sender wallet
        const senderQuote = await senderWallet.createMintQuoteBolt11(100);
        let quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofsBolt11(100, senderQuote.quote);
        expect(senderProofs.length).toBeGreaterThan(0);

        // Create P2PK locked token using cashu-ts send method with pubkey
        const sendAmount = 50;
        const { send: p2pkProofs } = await senderWallet.ops
          .send(sendAmount, senderProofs)
          .asP2PK({ pubkey: keypair.publicKeyHex })
          .run();

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
        const senderWallet = new Wallet(new Mint(mintUrl), {
          bip39seed: senderSeed,
        });
        await senderWallet.loadMint();

        // Fund the sender wallet
        const senderQuote = await senderWallet.createMintQuoteBolt11(100);
        let quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofsBolt11(
          100,
          senderQuote.quote,
          {},
          { type: 'deterministic', counter: 0 },
        );

        // Lock to a public key we don't have the private key for
        const fakePublicKey = '02' + '11'.repeat(31);
        const { send: p2pkProofs } = await senderWallet.ops
          .send(50, senderProofs)
          .asP2PK({ pubkey: fakePublicKey })
          .run();

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
        const senderWallet = new Wallet(new Mint(mintUrl));
        await senderWallet.loadMint();
        const keyset = senderWallet.keyChain.getCheapestKeyset();

        // Fund sender with more amount
        const senderQuote = await senderWallet.createMintQuoteBolt11(200);
        let quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
        let attempts = 0;
        while (quoteState.state !== 'PAID' && attempts <= 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          quoteState = await senderWallet.checkMintQuoteBolt11(senderQuote.quote);
          attempts++;
        }
        const senderProofs = await senderWallet.mintProofsBolt11(200, senderQuote.quote);

        const outputData = [
          OutputData.createSingleP2PKData({ pubkey: keypair.publicKeyHex }, 32, keyset.id),
          OutputData.createSingleP2PKData({ pubkey: keypair2.publicKeyHex }, 32, keyset.id),
        ];

        const keepFactory: OutputDataFactory = (a, k) => OutputData.createSingleRandomData(a, k.id);
        const outputConfig: OutputConfig = {
          send: { type: 'custom', data: outputData },
          keep: { type: 'factory', factory: keepFactory },
        };
        // Create P2PK token with multiple proofs
        const { send: p2pkProofs } = await senderWallet.send(
          64,
          senderProofs,
          undefined,
          outputConfig,
        );
        // Create P2PK token with multiple proofs
        // const { send: p2pkProofs } = await senderWallet.ops
        //   .send(64, senderProofs)
        //   .asP2PK({ pubkey: [keypair.publicKeyHex, keypair2.publicKeyHex] })
        //   .keepAsRandom()
        //   .run();

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
          const baseWallet = new Wallet(new Mint(mintUrl), {
            bip39seed: toBeSweptSeed,
          });
          await baseWallet.loadMint();

          // Create and pay mint quote
          const quote = await baseWallet.createMintQuoteBolt11(100);

          // Wait for quote to be marked as paid
          let quoteState = await baseWallet.checkMintQuoteBolt11(quote.quote);
          let attempts = 0;
          while (quoteState.state !== 'PAID' && attempts <= 3) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            quoteState = await baseWallet.checkMintQuoteBolt11(quote.quote);
            attempts++;
          }
          // Mint proofs to the wallet being swept
          const toBeSweptProofs = await baseWallet.mintProofsBolt11(
            100,
            quote.quote,
            {},
            { type: 'deterministic', counter: 0 },
          );
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

      it('should process an inband payment request', async () => {
        const pr = new PaymentRequest(
          [], // empty transport = inband
          'test-request-id',
          50,
          'sat',
          [mintUrl],
          'Test payment',
        );
        const encoded = pr.toEncodedRequest();

        const parsed = await mgr!.wallet.processPaymentRequest(encoded);

        expect(parsed.transport.type).toBe('inband');
        expect(parsed.amount).toBe(50);
        expect(parsed.requiredMints).toContain(mintUrl);
        expect(parsed.matchingMints).toContain(mintUrl);
      });

      it('should process an HTTP POST payment request', async () => {
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

        const parsed = await mgr!.wallet.processPaymentRequest(encoded);

        expect(parsed.transport.type).toBe('http');
        if (parsed.transport.type === 'http') {
          expect(parsed.transport.url).toBe(targetUrl);
        }
        expect(parsed.amount).toBe(75);
      });

      it('should process a payment request without amount', async () => {
        const pr = new PaymentRequest(
          [],
          'test-request-no-amount',
          undefined, // no amount
          'sat',
          [mintUrl],
        );
        const encoded = pr.toEncodedRequest();

        const parsed = await mgr!.wallet.processPaymentRequest(encoded);

        expect(parsed.transport.type).toBe('inband');
        expect(parsed.amount).toBe(undefined);
      });

      it('should handle inband payment request with amount in request', async () => {
        const pr = new PaymentRequest([], 'inband-with-amount', 30, 'sat', [mintUrl]);
        const encoded = pr.toEncodedRequest();

        const parsed = await mgr!.wallet.processPaymentRequest(encoded);
        expect(parsed.transport.type).toBe('inband');

        const balanceBefore = await mgr!.wallet.getBalances();
        const amountBefore = balanceBefore[mintUrl] || 0;

        let receivedToken: Token | undefined;
        if (parsed.transport.type === 'inband') {
          const transaction = await mgr!.wallet.preparePaymentRequestTransaction(mintUrl, parsed);
          await mgr!.wallet.handleInbandPaymentRequest(transaction, async (token) => {
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

        const parsed = await mgr!.wallet.processPaymentRequest(encoded);
        expect(parsed.transport.type).toBe('inband');
        expect(parsed.amount).toBe(undefined);

        let receivedToken: Token | undefined;
        if (parsed.transport.type === 'inband') {
          const transaction = await mgr!.wallet.preparePaymentRequestTransaction(
            mintUrl,
            parsed,
            25, // amount as parameter
          );
          await mgr!.wallet.handleInbandPaymentRequest(transaction, async (token) => {
            receivedToken = token;
          });
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

        // processPaymentRequest should throw because no matching mints found
        await expect(mgr!.wallet.processPaymentRequest(encoded)).rejects.toThrow();
      });

      it('should throw if amount is missing when preparing transaction', async () => {
        const pr = new PaymentRequest([], 'no-amount-request', undefined, 'sat', [mintUrl]);
        const encoded = pr.toEncodedRequest();

        const parsed = await mgr!.wallet.processPaymentRequest(encoded);

        if (parsed.transport.type === 'inband') {
          // Not providing amount when request doesn't have one should throw
          await expect(
            mgr!.wallet.preparePaymentRequestTransaction(mintUrl, parsed),
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

        await expect(mgr!.wallet.processPaymentRequest(encoded)).rejects.toThrow();
      });

      it('should complete full payment request flow with token reuse', async () => {
        // Create inband payment request
        const pr = new PaymentRequest([], 'full-flow-test', 40, 'sat', [mintUrl]);
        const encoded = pr.toEncodedRequest();

        // Process the payment request
        const parsed = await mgr!.wallet.processPaymentRequest(encoded);
        expect(parsed.transport.type).toBe('inband');

        // Prepare and handle the payment request
        let sentToken: Token | undefined;
        if (parsed.transport.type === 'inband') {
          const transaction = await mgr!.wallet.preparePaymentRequestTransaction(mintUrl, parsed);
          await mgr!.wallet.handleInbandPaymentRequest(transaction, async (token) => {
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
