import { testMintKeypairs } from '../fixtures/MintMetadata.ts';
import { Amount, deriveKeysetId } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import {
  ProofValidationError,
  ReceiveOperationConflictError,
  UnknownMintError,
} from '../../models/Error.ts';
import {
  createReceiveEnvironment,
  ReceiveTestRepositories,
  receiveToken,
  receiveMint,
  receiveKeys,
  receivedCoreProofs,
} from '../fixtures/ReceiveEnvironment.ts';

// Exercise the coordinator through real domain gateways, including independent sessions.
describe('Receive preparation and execution', () => {
  it('commits the signed request and allocation together, with no durable init', async () => {
    const repos = new ReceiveTestRepositories();
    const env = await createReceiveEnvironment(repos);
    const draft = await env.service.init(receiveToken());
    expect(await env.service.getOperation(draft.id)).toBeNull();
    expect(await repos.counterRepository.getCounter(receiveMint, receiveKeys)).toBeNull();
    const prepared = await env.service.prepare(draft);
    expect(await env.service.getOperation(draft.id)).toEqual(prepared);
    expect(prepared.revision).toBe(0);
    expect((await repos.counterRepository.getCounter(receiveMint, receiveKeys))?.counter).toBe(
      prepared.outputData.keep.length,
    );
    expect(repos.transactionCount).toBe(1);
    expect(await repos.proofRepository.getAvailableProofs(receiveMint)).toEqual([]);
  });

  it('rolls back the entire preparation when the commit fails and permits a retry', async () => {
    const repos = new ReceiveTestRepositories();
    const env = await createReceiveEnvironment(repos);
    const draft = await env.service.init(receiveToken());
    const onPrepared = mock(() => {});
    env.eventBus.on('receive-op:prepared', onPrepared);
    repos.failNextCommit = true;
    await expect(env.service.prepare(draft)).rejects.toThrow('Injected commit failure');
    expect(await env.service.getOperation(draft.id)).toBeNull();
    expect(await repos.counterRepository.getCounter(receiveMint, receiveKeys)).toBeNull();
    expect(onPrepared).not.toHaveBeenCalled();
    await env.service.prepare(draft);
    expect(onPrepared).toHaveBeenCalledTimes(1);
  });

  it('allocates disjoint outputs across independent coordinators', async () => {
    const env = await createReceiveEnvironment();
    const second = env.buildService();
    const firstDraft = await env.service.init(receiveToken());
    const secondDraft = await second.init(receiveToken());
    const prepared = await Promise.all([
      env.service.prepare(firstDraft),
      second.prepare(secondDraft),
    ]);
    const secrets = prepared.flatMap((operation) =>
      receivedCoreProofs(operation).map((proof) => proof.secret),
    );
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(
      (await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys))?.counter,
    ).toBe(secrets.length);
  });

  it('rechecks trust after preflight and rolls back without consuming counters', async () => {
    const env = await createReceiveEnvironment();
    const draft = await env.service.init(receiveToken());
    await env.repositories.mintRepository.setMintTrusted(receiveMint, false);
    await expect(env.service.prepare(draft)).rejects.toBeInstanceOf(UnknownMintError);
    expect(await env.service.getOperation(draft.id)).toBeNull();
  });

  it('validates duplicate input secrets and fees using current keysets', async () => {
    const env = await createReceiveEnvironment();
    const token = receiveToken();
    token.proofs.push(token.proofs[0]!);
    await expect(env.prepare(token)).rejects.toBeInstanceOf(ProofValidationError);
    const feeKeysetId = deriveKeysetId(testMintKeypairs, { unit: 'sat', input_fee_ppk: 1000 });
    await env.repositories.keysetRepository.addKeyset({
      mintUrl: receiveMint,
      id: feeKeysetId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 1000,
    });
    const feeToken = receiveToken(1);
    feeToken.proofs[0]!.id = feeKeysetId;
    const draft = await env.service.init(feeToken);
    await expect(env.service.prepare(draft)).rejects.toThrow('not sufficient after fees');
    expect(await env.service.getOperation(draft.id)).toBeNull();
  });

  it('rejects invalid input DLEQ before allocation or submission', async () => {
    const env = await createReceiveEnvironment();
    const token = receiveToken();
    token.proofs[0]!.dleq = { e: '00'.repeat(32), s: '00'.repeat(32), r: '01'.repeat(32) };
    await expect(env.prepare(token)).rejects.toBeInstanceOf(ProofValidationError);
    expect(await env.service.getPreparedOperations()).toEqual([]);
    expect(
      await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys),
    ).toBeNull();
    expect(env.remote.receive).not.toHaveBeenCalled();
  });

  it('preserves immutable request data when caller-owned objects are modified', async () => {
    const env = await createReceiveEnvironment();
    const prepared = await env.prepare();
    const original = await env.service.getOperation(prepared.id);
    prepared.inputProofs[0]!.secret = 'changed';
    prepared.outputData.keep[0]!.blindingFactor = 'changed';
    const result = await env.service.execute(prepared);
    expect(result.inputProofs).toEqual(original!.inputProofs);
    expect(env.remote.receive.mock.calls[0]![0].inputProofs).toEqual(original!.inputProofs);
    expect((await env.repositories.proofRepository.getAvailableProofs(receiveMint)).length).toBe(
      result.outputData.keep.length,
    );
  });

  it('persists P2PK witnesses and executes after removing key and seed access', async () => {
    const env = await createReceiveEnvironment();
    const secretKey = new Uint8Array(32).fill(2);
    const { schnorr } = await import('@noble/curves/secp256k1.js');
    const { bytesToHex } = await import('@noble/curves/utils.js');
    const publicKey = bytesToHex(schnorr.getPublicKey(secretKey));
    await env.repositories.keyRingRepository.setPersistedKeyPair({
      publicKeyHex: publicKey,
      secretKey,
      purpose: 'p2pk',
    });
    const token = receiveToken(
      7,
      JSON.stringify(['P2PK', { nonce: 'nonce', data: publicKey, tags: [] }]),
    );
    const prepared = await env.prepare(token);
    expect(prepared.inputProofs[0]!.witness).toBeDefined();
    await env.repositories.keyRingRepository.deletePersistedKeyPair(publicKey, 'p2pk');
    env.loadSeed.mockRejectedValue(new Error('Wallet locked'));
    const restarted = env.buildService();
    const finalized = await restarted.execute(prepared.id);
    expect(finalized.inputProofs).toEqual(prepared.inputProofs);
  });

  it('emits committed results with locks released; listener failure does not fail execution', async () => {
    const repos = new ReceiveTestRepositories();
    const env = await createReceiveEnvironment(repos);
    const prepared = await env.prepare();
    let delivered = 0;
    env.eventBus.on('proofs:saved', async () => {
      expect(repos.transactionOpen).toBe(false);
      expect(env.service.isOperationLocked(prepared.id)).toBe(false);
      expect((await env.service.getOperation(prepared.id))?.state).toBe('finalized');
      delivered++;
      throw new Error('Listener failure');
    });
    const finalized = await env.service.execute(prepared);
    expect(finalized.state).toBe('finalized');
    expect(delivered).toBe(1);
    expect(env.logger.warn).toHaveBeenCalled();
    expect(await env.service.execute(prepared.id)).toEqual(finalized);
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
  });

  it('lets only execution or cancellation win across coordinators', async () => {
    const env = await createReceiveEnvironment();
    const prepared = await env.prepare();
    const outcomes = await Promise.allSettled([
      env.service.execute(prepared),
      env.buildService().rollback(prepared.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const current = (await env.service.getOperation(prepared.id))!;
    expect(['finalized', 'rolled_back']).toContain(current.state);
    expect(env.remote.receive).toHaveBeenCalledTimes(current.state === 'finalized' ? 1 : 0);
  });

  it('cancels without reclaiming a committed counter allocation', async () => {
    const env = await createReceiveEnvironment();
    const prepared = await env.prepare();
    const before = await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys);
    await env.service.rollback(prepared.id);
    expect((await env.service.getOperation(prepared.id))?.state).toBe('rolled_back');
    expect(await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys)).toEqual(
      before,
    );
    await expect(env.service.execute(prepared)).rejects.toBeInstanceOf(
      ReceiveOperationConflictError,
    );
  });

  it('promotes a legacy init atomically using its persisted data and cleans abandoned init rows', async () => {
    const env = await createReceiveEnvironment();
    const draft = await env.service.init(receiveToken());
    await env.repositories.receiveOperationRepository.create(draft);
    const staleDraft = { ...draft, amount: Amount.from(999) };
    const prepared = await env.service.prepare(staleDraft);
    expect(prepared.amount).toEqual(draft.amount);
    expect(prepared.revision).toBe(1);
    const abandoned = await env.service.init(receiveToken());
    await env.repositories.receiveOperationRepository.create(abandoned);
    await env.service.recoverPendingOperations();
    expect(await env.service.getOperation(abandoned.id)).toBeNull();
    expect((await env.service.getOperation(prepared.id))?.state).toBe('prepared');
  });
});
