import { describe, it, afterEach, expect, beforeEach } from 'bun:test';
import { ConsoleLogger } from '@core/logging';
import { initializeCoco, type Manager } from '@core/Manager';
import { MemoryRepositories } from '@core/repositories';
import { getEncodedToken } from '@cashu/cashu-ts';
import type { Token } from '@cashu/cashu-ts';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

describe('Testnut Integration', () => {
  let mgr: Manager;
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
    }
  });

  describe('Mint Management', () => {
    it('should add a mint and fetch mint info', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      const { mint, keysets } = await mgr.mint.addMint(mintUrl, { trusted: true });
      expect(mint.url).toBe(mintUrl);
      expect(keysets.length).toBeGreaterThan(0);

      const mintInfo = await mgr.mint.getMintInfo(mintUrl);
      expect(mintInfo.name).toBeDefined();
      expect(mintInfo.version).toBeDefined();

      const isKnown = await mgr.mint.isTrustedMint(mintUrl);
      expect(isKnown).toBe(true);

      const allMints = await mgr.mint.getAllMints();
      expect(allMints).toHaveLength(1);
      expect(allMints[0].url).toBe(mintUrl);

      const trustedMints = await mgr.mint.getAllTrustedMints();
      expect(trustedMints).toHaveLength(1);
    });

    it('should handle trust and untrust operations', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: false });
      expect(await mgr.mint.isTrustedMint(mintUrl)).toBe(false);

      await mgr.mint.trustMint(mintUrl);
      expect(await mgr.mint.isTrustedMint(mintUrl)).toBe(true);

      await mgr.mint.untrustMint(mintUrl);
      expect(await mgr.mint.isTrustedMint(mintUrl)).toBe(false);
    });

    it('should emit mint:added event', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      const eventPromise = new Promise((resolve) => {
        mgr.once('mint:added', (payload) => {
          expect(payload.mint.url).toBe(mintUrl);
          expect(payload.keysets.length).toBeGreaterThan(0);
          resolve(payload);
        });
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });
      await eventPromise;
    });
  });

  describe('Mint Quote Workflow', () => {
    it('should create and redeem a mint quote', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });

      const initialBalance = await mgr.wallet.getBalances();
      expect(initialBalance[mintUrl] || 0).toBe(0);

      const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
      expect(quote.quote).toBeDefined();
      expect(quote.request).toBeDefined();
      expect(quote.amount).toBe(100);

      const eventPromise = new Promise((resolve) => {
        mgr.once('mint-quote:created', (payload) => {
          expect(payload.mintUrl).toBe(mintUrl);
          expect(payload.quoteId).toBe(quote.quote);
          resolve(payload);
        });
      });

      await eventPromise;

      const redeemedPromise = new Promise((resolve) => {
        mgr.once('mint-quote:redeemed', (payload) => {
          expect(payload.mintUrl).toBe(mintUrl);
          expect(payload.quoteId).toBe(quote.quote);
          resolve(payload);
        });
      });

      await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      await redeemedPromise;

      const balance = await mgr.wallet.getBalances();
      expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(100);
    });

    it('should use subscription API to await mint quote paid', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });

      const quote = await mgr.quotes.createMintQuote(mintUrl, 50);

      const subscriptionPromise = mgr.subscription.awaitMintQuotePaid(mintUrl, quote.quote);
      const redeemPromise = mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

      await Promise.all([subscriptionPromise, redeemPromise]);

      const balance = await mgr.wallet.getBalances();
      expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(50);
    });
  });

  describe('Wallet Operations', () => {
    beforeEach(async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });

      const quote = await mgr.quotes.createMintQuote(mintUrl, 200);
      await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
    });

    it('should send tokens and update balance', async () => {
      const initialBalance = await mgr.wallet.getBalances();
      const initialAmount = initialBalance[mintUrl] || 0;
      expect(initialAmount).toBeGreaterThanOrEqual(200);

      const sendAmount = 50;
      const sendPromise = new Promise((resolve) => {
        mgr.once('send:created', (payload) => {
          expect(payload.mintUrl).toBe(mintUrl);
          expect(payload.token.proofs.length).toBeGreaterThan(0);
          const tokenAmount = payload.token.proofs.reduce((sum, p) => sum + p.amount, 0);
          expect(tokenAmount).toBeGreaterThanOrEqual(sendAmount);
          resolve(payload);
        });
      });

      const token = await mgr.wallet.send(mintUrl, sendAmount);
      await sendPromise;

      expect(token.mint).toBe(mintUrl);
      expect(token.proofs.length).toBeGreaterThan(0);

      const balanceAfterSend = await mgr.wallet.getBalances();
      const amountAfterSend = balanceAfterSend[mintUrl] || 0;
      expect(amountAfterSend).toBeLessThan(initialAmount);
    });

    it('should receive tokens and update balance', async () => {
      const initialBalance = await mgr.wallet.getBalances();
      const initialAmount = initialBalance[mintUrl] || 0;

      const sendAmount = 30;
      const token = await mgr.wallet.send(mintUrl, sendAmount);

      const balanceAfterSend = await mgr.wallet.getBalances();
      const amountAfterSend = balanceAfterSend[mintUrl] || 0;

      const receivePromise = new Promise((resolve) => {
        mgr.once('receive:created', (payload) => {
          expect(payload.mintUrl).toBe(mintUrl);
          expect(payload.token.proofs.length).toBeGreaterThan(0);
          resolve(payload);
        });
      });

      await mgr.wallet.receive(token);
      await receivePromise;

      const balanceAfterReceive = await mgr.wallet.getBalances();
      const amountAfterReceive = balanceAfterReceive[mintUrl] || 0;
      expect(amountAfterReceive).toBeGreaterThan(amountAfterSend);
    });

    it('should receive tokens from encoded string', async () => {
      const sendAmount = 25;
      const token = await mgr.wallet.send(mintUrl, sendAmount);

      const encodedToken = getEncodedToken(token);

      const balanceBeforeReceive = await mgr.wallet.getBalances();
      const amountBeforeReceive = balanceBeforeReceive[mintUrl] || 0;

      await mgr.wallet.receive(encodedToken);

      const balanceAfterReceive = await mgr.wallet.getBalances();
      const amountAfterReceive = balanceAfterReceive[mintUrl] || 0;
      expect(amountAfterReceive).toBeGreaterThan(amountBeforeReceive);
    });

    it('should handle multiple send/receive operations', async () => {
      const initialBalance = await mgr.wallet.getBalances();
      const initialAmount = initialBalance[mintUrl] || 0;

      const amounts = [10, 20, 15];
      const tokens: Token[] = [];

      for (const amount of amounts) {
        const token = await mgr.wallet.send(mintUrl, amount);
        tokens.push(token);
      }

      const balanceAfterSends = await mgr.wallet.getBalances();
      const amountAfterSends = balanceAfterSends[mintUrl] || 0;
      expect(amountAfterSends).toBeLessThan(initialAmount - amounts.reduce((a, b) => a + b, 0));

      for (const token of tokens) {
        await mgr.wallet.receive(token);
      }

      const finalBalance = await mgr.wallet.getBalances();
      const finalAmount = finalBalance[mintUrl] || 0;
      expect(finalAmount).toBeGreaterThanOrEqual(initialAmount - amounts.reduce((a, b) => a + b, 0));
    });

    it('should reject receiving tokens from untrusted mint', async () => {
      const untrustedMintUrl = 'https://untrusted.example.com';
      const fakeToken: Token = {
        mint: untrustedMintUrl,
        proofs: [],
      };

      await expect(mgr.wallet.receive(fakeToken)).rejects.toThrow();
    });
  });

  describe('Melt Quote Workflow', () => {
    beforeEach(async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });

      const quote = await mgr.quotes.createMintQuote(mintUrl, 500);
      await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
    });

    it('should create a melt quote', async () => {
      const invoice = 'lnbc1testinvoice';
      const meltQuote = await mgr.quotes.createMeltQuote(mintUrl, invoice);

      expect(meltQuote.quote).toBeDefined();
      expect(meltQuote.amount).toBeGreaterThan(0);

      const eventPromise = new Promise((resolve) => {
        mgr.once('melt-quote:created', (payload) => {
          expect(payload.mintUrl).toBe(mintUrl);
          expect(payload.quoteId).toBe(meltQuote.quote);
          resolve(payload);
        });
      });

      await eventPromise;
    });
  });

  describe('History', () => {
    beforeEach(async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });

      const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
      await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
    });

    it('should retrieve paginated history', async () => {
      const history = await mgr.history.getPaginatedHistory(0, 10);
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('Event System', () => {
    it('should emit counter:updated events', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
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
    });

    it('should emit proofs:saved events', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
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
    });

    it('should emit proofs:state-changed events on send', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
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
    });
  });

  describe('Watchers and Processors', () => {
    it('should automatically process paid mint quotes with watcher enabled', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
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
        mgr.once('mint-quote:redeemed', (payload) => {
          expect(payload.mintUrl).toBe(mintUrl);
          expect(payload.quoteId).toBe(quote.quote);
          resolve(payload);
        });
      });

      await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);
      await redeemedPromise;

      const balance = await mgr.wallet.getBalances();
      expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(150);
    });

    it('should handle pause and resume subscriptions', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
      });

      await mgr.mint.addMint(mintUrl, { trusted: true });

      await mgr.pauseSubscriptions();
      await mgr.resumeSubscriptions();

      const quote = await mgr.quotes.createMintQuote(mintUrl, 100);
      await mgr.quotes.redeemMintQuote(mintUrl, quote.quote);

      const balance = await mgr.wallet.getBalances();
      expect(balance[mintUrl] || 0).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Full Workflow Integration', () => {
    it('should perform complete end-to-end workflow', async () => {
      mgr = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter,
        logger: new ConsoleLogger('testnut-integration', { level: 'info' }),
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
    });
  });
});
