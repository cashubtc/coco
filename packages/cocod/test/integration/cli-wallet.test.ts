import { afterEach, expect, test } from 'bun:test';
import { Amount, type SendOperation } from '@cashu/coco-core';

import { createV1Client, V1ClientError } from '../../src/cli-shared.js';
import { cleanupTransferHarnesses, startTransferHarness } from '../helpers/transfer-harness.js';

afterEach(cleanupTransferHarnesses);

function rolledBackSend(mintUrl: string): SendOperation {
  return {
    id: 'send-rolled-back',
    state: 'rolled_back',
    mintUrl,
    amount: Amount.from(5),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    needsSwap: false,
    fee: Amount.from(0),
    inputAmount: Amount.from(5),
    inputProofSecrets: [],
    token: { mint: mintUrl, proofs: [] },
  } as unknown as SendOperation;
}

test('let the CLI client inspect an Operation and report why it cannot be cancelled', async () => {
  const harness = await startTransferHarness();
  await harness.repositories.sendOperationRepository.create(rolledBackSend(harness.mint.url));
  const client = createV1Client({
    url: harness.url,
    credentialFile: harness.clientCredentialFile,
  });

  expect(await client.getOperation('send', 'send-rolled-back')).toMatchObject({
    id: 'send-rolled-back',
    state: 'rolled_back',
  });
  const cancelling = client.cancelOperation('send', 'send-rolled-back');
  await expect(cancelling).rejects.toBeInstanceOf(V1ClientError);
  await expect(cancelling).rejects.toMatchObject({
    status: 409,
    code: 'invalid_operation_state',
  });
  await expect(client.getOperation('melt', 'missing')).rejects.toMatchObject({
    status: 404,
    code: 'not_found',
  });
});
