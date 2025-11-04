import { describe, it, afterEach, expect } from 'bun:test';
import { ConsoleLogger } from '@core/logging';
import { initializeCoco, type Manager } from '@core/Manager';
import { MemoryRepositories } from '@core/repositories';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

describe('Testnut Integration', () => {
  let mgr: Manager;

  const seedGetterFactory = async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64));
    return async () => seed;
  };

  afterEach(async () => {
    if (mgr) {
      await mgr.pauseSubscriptions();
      await mgr.dispose();
    }
  });

  it('should perform full wallet workflow', async () => {
    const seedGetter = await seedGetterFactory();
    mgr = await initializeCoco({
      repo: new MemoryRepositories(),
      seedGetter,
      logger: new ConsoleLogger('testnut-integration', { level: 'debug' }),
    });

    await mgr.mint.addMint(mintUrl, { trusted: true });

    const balance = await mgr.wallet.getBalances();
    console.log('balance', balance);

    const quote = await mgr.quotes.createMintQuote(mintUrl, 100);

    await new Promise((resolve) => {
      mgr.on('mint-quote:redeemed', (payload) => {
        if (payload.mintUrl === mintUrl) {
          resolve(payload);
        }
      });
    });

    const inbetweenBalance = await mgr.wallet.getBalances();
    console.log('inbetweenBalance', inbetweenBalance);

    const token = await mgr.wallet.send(mintUrl, 10);
    console.log('token', token);

    const balance2 = await mgr.wallet.getBalances();
    console.log('balance2', balance2);

    await mgr.wallet.receive(token);

    const balance3 = await mgr.wallet.getBalances();
    console.log(balance3);
  });
});
