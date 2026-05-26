import { Amount } from '@cashu/cashu-ts';
import { NullLogger } from '../../logging/index.ts';
import { initializeCoco, type Manager } from '../../Manager.ts';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryRepositories } from '../../repositories/memory/index.ts';
import type { ReceiveOperationRepository } from '../../repositories/index.ts';
import type { FinalizedReceiveOperation } from '@core/operations/receive/ReceiveOperation.ts';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService.ts';

describe('ReceiveOperationService integration', () => {
  let sender: Manager;
  let receiver: Manager;
  const mintUrl = 'http://localhost:3338';

  // Returns an async function that generates a random 64-byte Uint8Array as seed
  const makeSeedGetter = () => async () => {
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    return arr;
  };

  beforeEach(async () => {
    const senderRepos = new MemoryRepositories();
    const receiverRepos = new MemoryRepositories();
    await senderRepos.init();
    await receiverRepos.init();

    const baseConfig = {
      logger: new NullLogger(),
      watchers: {
        mintOperationWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
      },
      processors: {
        mintOperationProcessor: { disabled: true },
      },
    };

    sender = await initializeCoco({
      repo: senderRepos,
      seedGetter: makeSeedGetter(),
      ...baseConfig,
    });

    receiver = await initializeCoco({
      repo: receiverRepos,
      seedGetter: makeSeedGetter(),
      ...baseConfig,
    });
  });

  afterEach(async () => {
    if (sender) {
      await sender.pauseSubscriptions();
      await sender.dispose();
    }
    if (receiver) {
      await receiver.pauseSubscriptions();
      await receiver.dispose();
    }
  });

  it('receive() orchestrates init -> prepare -> execute and finalizes the operation', async () => {
    await sender.mint.addMint(mintUrl, { trusted: true });
    await receiver.mint.addMint(mintUrl, { trusted: true });

    const quote = await sender.quotes.mint.create({
      mintUrl,
      amount: Amount.from(50),
      method: 'bolt11',
    });
    const pendingMint = await sender.ops.mint.prepare({
      mintUrl,
      quoteId: quote.quoteId,
      method: 'bolt11',
      methodData: {},
    });
    await sender.ops.mint.execute(pendingMint.id);

    const preparedSend = await sender.ops.send.prepare({ mintUrl, amount: Amount.from(30) });
    const { token } = await sender.ops.send.execute(preparedSend.id);

    const receiveService = (receiver as any).receiveOperationService as ReceiveOperationService;
    const receiveRepo = (receiver as any).receiveOperationRepository as ReceiveOperationRepository;

    const receiveEvent = new Promise((resolve) => {
      receiver.once('receive-op:finalized', resolve);
    });

    await receiveService.receive(token);
    await receiveEvent;

    const finalized = await receiveRepo.getByState('finalized');

    expect(finalized.length).toBe(1);
    const op = finalized[0] as FinalizedReceiveOperation;

    const tokenAmount = Amount.sum(token.proofs.map((proof) => proof.amount));
    expect(op?.amount).toEqual(tokenAmount);
    expect(op?.outputData).toBeDefined();
  }, 30000);
});
