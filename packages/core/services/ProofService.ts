import {
  OutputData,
  type Keys,
  type MintKeys,
  type Proof,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import type { CoreProof, BalanceBreakdown, BalancesBreakdownByMint } from '../types';
import type { CounterService } from './CounterService';
import type { ProofRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import { ProofOperationError, ProofValidationError } from '../models/Error';
import { WalletService } from './WalletService';
import type { MintService } from './MintService';
import type { Logger } from '../logging/Logger.ts';
import type { SeedService } from './SeedService.ts';
import type { KeyRingService } from './KeyRingService.ts';
import { deserializeOutputData, mapProofToCoreProof, type SerializedOutputData } from '../utils';
import type { Keyset } from '@core/models/Keyset.ts';

export class ProofService {
  private readonly counterService: CounterService;
  private readonly proofRepository: ProofRepository;
  private readonly eventBus?: EventBus<CoreEvents>;
  private readonly walletService: WalletService;
  private readonly mintService: MintService;
  private readonly keyRingService: KeyRingService;
  private readonly seedService: SeedService;
  private readonly logger?: Logger;
  constructor(
    counterService: CounterService,
    proofRepository: ProofRepository,
    walletService: WalletService,
    mintService: MintService,
    keyRingService: KeyRingService,
    seedService: SeedService,
    logger?: Logger,
    eventBus?: EventBus<CoreEvents>,
  ) {
    this.counterService = counterService;
    this.walletService = walletService;
    this.mintService = mintService;
    this.keyRingService = keyRingService;
    this.proofRepository = proofRepository;
    this.seedService = seedService;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /**
   * Calculates the send amount including receiver fees.
   * This is used when the sender pays fees for the receiver.
   */
  async calculateSendAmountWithFees(mintUrl: string, sendAmount: number): Promise<number> {
    const { wallet, keys, keysetId } =
      await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    // Split the send amount to determine number of outputs
    let denominations = splitAmount(sendAmount, keys.keys);

    // Calculate receiver fees (sender pays fees)
    let receiveFee = wallet.getFeesForKeyset(denominations.length, keysetId);
    let receiveFeeAmounts = splitAmount(receiveFee, keys.keys);

    // Iterate until fee calculation stabilizes
    while (
      wallet.getFeesForKeyset(denominations.length + receiveFeeAmounts.length, keysetId) >
      receiveFee
    ) {
      receiveFee++;
      receiveFeeAmounts = splitAmount(receiveFee, keys.keys);
    }

    return sendAmount + receiveFee;
  }

  async checkInflightProofs() {
    const inflightProofs = await this.proofRepository.getInflightProofs();
    this.logger?.debug('Checking inflight proofs', { count: inflightProofs.length });
    if (inflightProofs.length === 0) {
      return;
    }
    const batchedByMint: { [mintUrl: string]: CoreProof[] } = {};
    for (const proof of inflightProofs) {
      const mintUrl = proof.mintUrl;
      if (!mintUrl) continue;
      const batch = batchedByMint[mintUrl] ?? (batchedByMint[mintUrl] = []);
      batch.push(proof);
    }
    const mintUrls = Object.keys(batchedByMint);
    for (const mintUrl of mintUrls) {
      const proofs = batchedByMint[mintUrl];
      if (!proofs || proofs.length === 0) {
        continue;
      }
      this.logger?.debug('Checking inflight proofs for mint', {
        mintUrl,
        count: proofs.length,
      });
      try {
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
        const proofStates = await wallet.checkProofsStates(proofs);
        if (!Array.isArray(proofStates) || proofStates.length !== proofs.length) {
          this.logger?.warn('Malformed proof state check response', {
            mintUrl,
            expected: proofs.length,
            received: (proofStates as { length?: number } | null | undefined)?.length ?? 0,
          });
          continue;
        }
        const spentSecrets = proofStates.reduce<string[]>((acc, state, index) => {
          if (state?.state === 'SPENT' && proofs[index]?.secret) {
            acc.push(proofs[index].secret);
          }
          return acc;
        }, []);
        if (spentSecrets.length > 0) {
          await this.setProofState(mintUrl, spentSecrets, 'spent');
          this.logger?.info('Marked inflight proofs as spent after check', {
            mintUrl,
            count: spentSecrets.length,
          });
        }
      } catch (error) {
        this.logger?.warn('Failed to check inflight proofs for mint', {
          mintUrl,
          error,
        });
      }
    }
  }

  async createOutputsAndIncrementCounters(
    mintUrl: string,
    amount: { keep: number; send: number },
    options?: { includeFees?: boolean },
  ): Promise<{ keep: OutputData[]; send: OutputData[]; sendAmount: number; keepAmount: number }> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (
      !Number.isFinite(amount.keep) ||
      !Number.isFinite(amount.send) ||
      amount.keep < 0 ||
      amount.send < 0
    ) {
      return { keep: [], send: [], sendAmount: 0, keepAmount: 0 };
    }
    const { wallet, keys, keysetId } =
      await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const seed = await this.seedService.getSeed();
    const currentCounter = await this.counterService.getCounter(mintUrl, keys.id);
    const data: { keep: OutputData[]; send: OutputData[] } = { keep: [], send: [] };

    // Calculate send amount with fees if needed
    let sendAmount = amount.send;
    let keepAmount = amount.keep;
    if (options?.includeFees && amount.send > 0) {
      sendAmount = await this.calculateSendAmountWithFees(mintUrl, amount.send);
      const feeAmount = sendAmount - amount.send;
      // Adjust keep amount: if send increases due to fees, keep decreases
      keepAmount = Math.max(0, amount.keep - feeAmount);
      this.logger?.debug('Fee calculation for send amount', {
        mintUrl,
        originalSendAmount: amount.send,
        originalKeepAmount: amount.keep,
        feeAmount,
        finalSendAmount: sendAmount,
        adjustedKeepAmount: keepAmount,
      });
    }

    if (keepAmount > 0) {
      data.keep = OutputData.createDeterministicData(
        keepAmount,
        seed,
        currentCounter.counter,
        keys,
      );
      if (data.keep.length > 0) {
        await this.counterService.incrementCounter(mintUrl, keys.id, data.keep.length);
      }
    }
    if (sendAmount > 0) {
      data.send = OutputData.createDeterministicData(
        sendAmount,
        seed,
        currentCounter.counter + data.keep.length,
        keys,
      );
      if (data.send.length > 0) {
        await this.counterService.incrementCounter(mintUrl, keys.id, data.send.length);
      }
    }
    this.logger?.debug('Deterministic outputs created', {
      mintUrl,
      keysetId: keys.id,
      amount,
      outputs: data.keep.length + data.send.length,
    });
    return { keep: data.keep, send: data.send, sendAmount, keepAmount };
  }

  async saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!Array.isArray(proofs) || proofs.length === 0) return;

    const groupedByKeyset = this.groupProofsByKeysetId(proofs);

    const entries = Array.from(groupedByKeyset.entries());
    const tasks = entries.map(([keysetId, group]) =>
      (async () => {
        await this.proofRepository.saveProofs(mintUrl, group);
        await this.eventBus?.emit('proofs:saved', {
          mintUrl,
          keysetId,
          proofs: group,
        });
        this.logger?.info('Proofs saved', { mintUrl, keysetId, count: group.length });
      })().catch((error) => {
        // Enrich the rejection with keyset context so we can log precise details later
        throw { keysetId, error };
      }),
    );
    const results = await Promise.allSettled(tasks);

    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      // Log each failure with its original error for maximum visibility
      for (const fr of failed) {
        const { keysetId, error } = fr.reason as { keysetId?: string; error?: unknown };
        this.logger?.error('Failed to persist proofs for keyset', { mintUrl, keysetId, error });
      }
      const details = failed.map((fr) => fr.reason as { keysetId?: string; error?: unknown });
      const failedKeysets = details
        .map((d) => d.keysetId)
        .filter((id): id is string => Boolean(id));
      const aggregate = new AggregateError(
        details.map((d) => (d?.error instanceof Error ? d.error : new Error(String(d?.error)))),
        `Failed to persist proofs for ${failed.length} keyset group(s)`,
      );
      const message =
        failedKeysets.length > 0
          ? `Failed to persist proofs for ${failed.length} keyset group(s) [${failedKeysets.join(
              ', ',
            )}]`
          : `Failed to persist proofs for ${failed.length} keyset group(s)`;
      throw new ProofOperationError(mintUrl, message, undefined, aggregate);
    }
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    return this.proofRepository.getReadyProofs(mintUrl);
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    return this.proofRepository.getAllReadyProofs();
  }

  /**
   * Gets the balance for a single mint by summing ready proof amounts.
   * @param mintUrl - The URL of the mint
   * @returns The total balance for the mint
   */
  async getBalance(mintUrl: string): Promise<number> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    const proofs = await this.proofRepository.getAvailableProofs(mintUrl);
    return proofs.reduce((acc, proof) => acc + proof.amount, 0);
  }

  /**
   * Gets balances for all mints by summing ready proof amounts.
   * @returns An object mapping mint URLs to their balances
   */
  async getBalances(): Promise<{ [mintUrl: string]: number }> {
    const proofs = await this.getAllReadyProofs();
    const balances: { [mintUrl: string]: number } = {};
    for (const proof of proofs) {
      if (proof.usedByOperationId) continue;
      const mintUrl = proof.mintUrl;
      const balance = balances[mintUrl] || 0;
      balances[mintUrl] = balance + proof.amount;
    }
    return balances;
  }

  /**
   * Gets balances for trusted mints only by summing ready proof amounts.
   * @returns An object mapping trusted mint URLs to their balances
   */
  async getTrustedBalances(): Promise<{ [mintUrl: string]: number }> {
    const balances = await this.getBalances();
    const trustedMints = await this.mintService.getAllTrustedMints();
    const trustedUrls = new Set(trustedMints.map((m) => m.mintUrl));

    const trustedBalances: { [mintUrl: string]: number } = {};
    for (const [mintUrl, balance] of Object.entries(balances)) {
      if (trustedUrls.has(mintUrl)) {
        trustedBalances[mintUrl] = balance;
      }
    }
    return trustedBalances;
  }

  /**
   * Gets detailed balance breakdown for a single mint.
   * @param mintUrl - The URL of the mint
   * @returns Balance breakdown with ready, reserved, and total amounts
   */
  async getBalanceBreakdown(mintUrl: string): Promise<BalanceBreakdown> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    const proofs = await this.getReadyProofs(mintUrl);
    let ready = 0;
    let reserved = 0;
    for (const proof of proofs) {
      if (proof.usedByOperationId) {
        reserved += proof.amount;
      } else {
        ready += proof.amount;
      }
    }
    return { ready, reserved, total: ready + reserved };
  }

  /**
   * Gets detailed balance breakdown for all mints.
   * @returns An object mapping mint URLs to their balance breakdowns
   */
  async getBalancesBreakdown(): Promise<BalancesBreakdownByMint> {
    const proofs = await this.getAllReadyProofs();
    const balances: BalancesBreakdownByMint = {};
    for (const proof of proofs) {
      const mintUrl = proof.mintUrl;
      const balance = balances[mintUrl] || { ready: 0, reserved: 0, total: 0 };
      if (proof.usedByOperationId) {
        balance.reserved += proof.amount;
      } else {
        balance.ready += proof.amount;
      }
      balance.total = balance.ready + balance.reserved;
      balances[mintUrl] = balance;
    }
    return balances;
  }

  /**
   * Gets detailed balance breakdown for trusted mints only.
   * @returns An object mapping trusted mint URLs to their balance breakdowns
   */
  async getTrustedBalancesBreakdown(): Promise<BalancesBreakdownByMint> {
    const balances = await this.getBalancesBreakdown();
    const trustedMints = await this.mintService.getAllTrustedMints();
    const trustedUrls = new Set(trustedMints.map((m) => m.mintUrl));

    const trustedBalances: BalancesBreakdownByMint = {};
    for (const [mintUrl, balance] of Object.entries(balances)) {
      if (trustedUrls.has(mintUrl)) {
        trustedBalances[mintUrl] = balance;
      }
    }
    return trustedBalances;
  }

  async setProofState(
    mintUrl: string,
    secrets: string[],
    state: 'inflight' | 'ready' | 'spent',
  ): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;
    await this.proofRepository.setProofState(mintUrl, secrets, state);
    await this.eventBus?.emit('proofs:state-changed', {
      mintUrl,
      secrets,
      state,
    });
    this.logger?.debug('Proof state updated', { mintUrl, count: secrets.length, state });
  }

  /**
   * Reserve proofs for an operation.
   * Validates that proofs are available (ready and not already reserved) before reserving.
   * Emits 'proofs:reserved' event on success.
   *
   * @throws ProofOperationError if any proof is not available for reservation
   */
  async reserveProofs(
    mintUrl: string,
    secrets: string[],
    operationId: string,
  ): Promise<{ amount: number }> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!operationId || operationId.trim().length === 0) {
      throw new ProofValidationError('operationId is required');
    }
    if (!secrets || secrets.length === 0) {
      return { amount: 0 };
    }

    // Repository will validate proofs are ready and not already reserved
    await this.proofRepository.reserveProofs(mintUrl, secrets, operationId);

    // Calculate the reserved amount for the event
    const reservedProofs = await this.proofRepository.getProofsByOperationId(mintUrl, operationId);
    const amount = reservedProofs.reduce((acc, p) => acc + p.amount, 0);

    await this.eventBus?.emit('proofs:reserved', {
      mintUrl,
      operationId,
      secrets,
      amount,
    });
    this.logger?.debug('Proofs reserved', {
      mintUrl,
      operationId,
      count: secrets.length,
      amount,
    });

    return { amount };
  }

  /**
   * Release proofs from an operation.
   * Clears the reservation so proofs become available again.
   * Emits 'proofs:released' event on success.
   */
  async releaseProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;

    await this.proofRepository.releaseProofs(mintUrl, secrets);

    await this.eventBus?.emit('proofs:released', { mintUrl, secrets });
    this.logger?.debug('Proofs released', { mintUrl, count: secrets.length });
  }

  /**
   * Restore proofs to ready state and clear their operation reservation.
   * Used during rollback when inflight proofs need to be made available again.
   * This sets state to 'ready' and clears usedByOperationId.
   */
  async restoreProofsToReady(mintUrl: string, secrets: string[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;

    await this.proofRepository.setProofState(mintUrl, secrets, 'ready');
    await this.proofRepository.releaseProofs(mintUrl, secrets);

    await this.eventBus?.emit('proofs:state-changed', { mintUrl, secrets, state: 'ready' });
    await this.eventBus?.emit('proofs:released', { mintUrl, secrets });
    this.logger?.debug('Proofs restored to ready', { mintUrl, count: secrets.length });
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;
    await this.proofRepository.deleteProofs(mintUrl, secrets);
    await this.eventBus?.emit('proofs:deleted', { mintUrl, secrets });
    this.logger?.info('Proofs deleted', { mintUrl, count: secrets.length });
  }

  async wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!keysetId || keysetId.trim().length === 0) {
      throw new ProofValidationError('keysetId is required');
    }
    await this.proofRepository.wipeProofsByKeysetId(mintUrl, keysetId);
    await this.eventBus?.emit('proofs:wiped', { mintUrl, keysetId });
    this.logger?.info('Proofs wiped by keyset', { mintUrl, keysetId });
  }

  /**
   * Select proofs to send for a given amount.
   * Uses the wallet's proof selection algorithm to choose optimal denominations.
   *
   * @param mintUrl - The mint URL to select proofs from
   * @param amount - The amount to send
   * @param includeFees - Whether to include fees in the selection (default: true)
   * @returns The selected proofs
   * @throws ProofValidationError if insufficient balance to cover the amount
   */
  async selectProofsToSend(
    mintUrl: string,
    amount: number,
    includeFees: boolean = true,
  ): Promise<Proof[]> {
    const proofs = await this.getReadyProofs(mintUrl);
    const totalAmount = proofs.reduce((acc, proof) => acc + proof.amount, 0);
    if (totalAmount < amount) {
      throw new ProofValidationError('Not enough proofs to send');
    }
    const wallet = await this.walletService.getWallet(mintUrl);
    const selectedProofs = wallet.selectProofsToSend(proofs, amount, includeFees);
    this.logger?.debug('Selected proofs to send', {
      mintUrl,
      amount,
      selectedProofs,
      count: selectedProofs.send.length,
    });
    return selectedProofs.send;
  }
  private groupProofsByKeysetId(proofs: CoreProof[]): Map<string, CoreProof[]> {
    const map = new Map<string, CoreProof[]>();
    for (const proof of proofs) {
      if (!proof.secret) throw new ProofValidationError('Proof missing secret');
      const keysetId = proof.id;
      if (!keysetId || keysetId.trim().length === 0) {
        throw new ProofValidationError('Proof missing keyset id');
      }
      const existing = map.get(keysetId);
      if (existing) {
        existing.push(proof);
      } else {
        map.set(keysetId, [proof]);
      }
    }
    return map;
  }

  async getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]> {
    return this.proofRepository.getProofsByKeysetId(mintUrl, keysetId);
  }

  async hasProofsForKeyset(mintUrl: string, keysetId: string): Promise<boolean> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!keysetId || keysetId.trim().length === 0) {
      throw new ProofValidationError('keysetId is required');
    }

    const proofs = await this.proofRepository.getProofsByKeysetId(mintUrl, keysetId);
    const hasProofs = proofs.length > 0;

    this.logger?.debug('Checked proofs for keyset', {
      mintUrl,
      keysetId,
      hasProofs,
      totalProofs: proofs.length,
    });

    return hasProofs;
  }

  async prepareProofsForReceiving(proofs: Proof[]): Promise<Proof[]> {
    this.logger?.debug('Preparing proofs for receiving', { totalProofs: proofs.length });

    const preparedProofs = [...proofs];
    let regularProofCount = 0;
    let p2pkProofCount = 0;

    for (let i = 0; i < preparedProofs.length; i++) {
      const proof = preparedProofs[i];
      if (!proof) continue;

      // Try to parse as P2PK proof
      let parsedSecret: [string, { nonce: string; data: string; tags: string[][] }];
      try {
        parsedSecret = JSON.parse(proof.secret);
      } catch (parseError) {
        // Not a JSON secret (regular proof), skip P2PK processing
        this.logger?.debug('Regular proof detected, skipping P2PK processing', {
          proofIndex: i,
        });
        regularProofCount++;
        continue;
      }

      // Check if it's a P2PK proof
      if (parsedSecret[0] !== 'P2PK') {
        this.logger?.error('Unsupported locking script type', {
          proofIndex: i,
          scriptType: parsedSecret[0],
        });
        throw new ProofValidationError('Only P2PK locking scripts are supported');
      }

      // Validate multisig is not used
      const additionalKeysTag = parsedSecret[1].tags?.find((tag) => tag[0] === 'pubkeys');
      if (additionalKeysTag && additionalKeysTag[1] && additionalKeysTag[1].length > 0) {
        this.logger?.error('Multisig P2PK proof detected', { proofIndex: i });
        throw new ProofValidationError('Multisig is not supported');
      }

      // Sign the proof - if this fails, we abort the entire operation
      try {
        preparedProofs[i] = await this.keyRingService.signProof(proof, parsedSecret[1].data);
        this.logger?.debug('P2PK proof signed successfully', {
          proofIndex: i,
          recipient: parsedSecret[1].data,
        });
        p2pkProofCount++;
      } catch (error) {
        this.logger?.error('Failed to sign P2PK proof for receiving', {
          proofIndex: i,
          recipient: parsedSecret[1].data,
          error,
        });
        throw error;
      }
    }

    this.logger?.info('Proofs prepared for receiving', {
      totalProofs: proofs.length,
      regularProofs: regularProofCount,
      p2pkProofs: p2pkProofCount,
    });

    return preparedProofs;
  }

  async createBlankOutputs(amount: number, mintUrl: string): Promise<OutputData[]> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ProofValidationError('amount must be a non-negative number');
    }
    const { keys } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    if (amount === 0) {
      return [];
    }
    const outputNumber = Math.max(Math.ceil(Math.log2(amount)), 1);
    const currentCounter = await this.counterService.getCounter(mintUrl, keys.id);
    const seed = await this.seedService.getSeed();
    const outputData = Array(outputNumber)
      .fill(0)
      .map((_, index) => {
        return OutputData.createSingleDeterministicData(
          0,
          seed,
          currentCounter.counter + index,
          keys.id,
        );
      });
    if (outputData.length > 0) {
      await this.counterService.incrementCounter(mintUrl, keys.id, outputData.length);
    }
    return outputData;
  }

  /**
   * Unblind change signatures and save the resulting proofs.
   * Used after melt operations to process change returned by the mint.
   *
   * @param mintUrl - The mint URL
   * @param outputData - The output data used to create blank outputs for change
   * @param changeSignatures - The blinded signatures returned by the mint
   * @param keys - The mint keys for unblinding
   * @param options - Optional settings including createdByOperationId
   * @returns The saved change proofs
   */
  async unblindAndSaveChangeProofs(
    mintUrl: string,
    outputData: OutputData[],
    changeSignatures: SerializedBlindedSignature[],
    options?: { createdByOperationId?: string },
  ): Promise<CoreProof[]> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (
      !outputData ||
      outputData.length === 0 ||
      !changeSignatures ||
      changeSignatures.length === 0
    ) {
      return [];
    }
    const { keysets } = await this.mintService.ensureUpdatedMint(mintUrl);
    const keysetMap: { [id: string]: Keyset } = {};
    keysets.forEach((ks) => {
      keysetMap[ks.id] = ks;
    });

    // Slice output data to match signature count
    const matchedOutputs = outputData.slice(0, changeSignatures.length);

    // Unblind each signature to create proofs
    const proofs: Proof[] = matchedOutputs.flatMap((output, i) => {
      const sig = changeSignatures[i];
      const keyset = keysetMap[output.blindedMessage.id];
      if (!sig || !keyset) {
        const reason = !sig ? 'missing signature' : 'missing keyset';
        this.logger?.warn('Failed to create change proof', { reason, index: i });
        return [];
      }
      return [output.toProof(sig, { id: keyset.id, keys: keyset.keypairs })];
    });

    if (proofs.length === 0) {
      return [];
    }

    // Map to CoreProof and save
    const coreProofs = mapProofToCoreProof(mintUrl, 'ready', proofs, {
      createdByOperationId: options?.createdByOperationId,
    });

    await this.saveProofs(mintUrl, coreProofs);

    this.logger?.info('Change proofs unblinded and saved', {
      mintUrl,
      count: coreProofs.length,
      operationId: options?.createdByOperationId,
    });

    return coreProofs;
  }

  /**
   * Recover proofs from a completed swap using the mint's restore endpoint.
   * This is used when a swap succeeded but proofs were not saved (e.g., crash recovery).
   *
   * First checks if the proofs are still unspent before attempting recovery.
   * Only unspent proofs will be recovered and saved.
   *
   * @param mintUrl - The mint URL
   * @param serializedOutputData - The serialized output data containing secrets and blinding factors
   * @returns The recovered proofs (only unspent ones)
   */
  async recoverProofsFromOutputData(
    mintUrl: string,
    serializedOutputData: SerializedOutputData,
  ): Promise<Proof[]> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!serializedOutputData) {
      throw new ProofValidationError('serializedOutputData is required');
    }

    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

    // Deserialize OutputData
    const outputData = deserializeOutputData(serializedOutputData);
    const allOutputs = [...outputData.keep, ...outputData.send];

    if (allOutputs.length === 0) {
      return [];
    }

    // Build blinded messages for restore request
    const blindedMessages = allOutputs.map((o) => o.blindedMessage);

    // Call mint restore endpoint
    const restoreResult = await wallet.mint.restore({ outputs: blindedMessages });

    // Match signatures back to outputs and construct proofs
    const restoredProofs: Proof[] = [];
    for (let i = 0; i < restoreResult.outputs.length; i++) {
      const output = allOutputs.find((o) => o.blindedMessage.B_ === restoreResult.outputs[i]?.B_);
      const signature = restoreResult.signatures[i];
      if (output && signature) {
        // Construct proof from output data and signature
        const proof: Proof = {
          id: signature.id,
          amount: signature.amount,
          secret: new TextDecoder().decode(output.secret),
          C: signature.C_,
        };
        restoredProofs.push(proof);
      }
    }

    if (restoredProofs.length === 0) {
      this.logger?.debug('No proofs found to restore', { mintUrl });
      return [];
    }

    // Check which proofs are still unspent
    const proofStates = await wallet.checkProofsStates(restoredProofs);
    const unspentProofs = restoredProofs.filter((_, index) => {
      const state = proofStates[index];
      return state && state.state === 'UNSPENT';
    });

    if (unspentProofs.length === 0) {
      this.logger?.debug('All restored proofs are already spent', {
        mintUrl,
        totalRestored: restoredProofs.length,
      });
      return [];
    }

    // Save only unspent proofs
    await this.saveProofs(mintUrl, mapProofToCoreProof(mintUrl, 'ready', unspentProofs));

    this.logger?.info('Recovered proofs from output data', {
      mintUrl,
      totalRestored: restoredProofs.length,
      unspentCount: unspentProofs.length,
      spentCount: restoredProofs.length - unspentProofs.length,
    });

    return unspentProofs;
  }
}

/**
 * Splits the amount into denominations of the provided keyset.
 *
 * @remarks
 * Partial splits will be filled up to value using minimum splits required. Sorting is only applied
 * if a fill was made - exact custom splits are always returned in the same order.
 * @param value Amount to split.
 * @param keyset Keys to look up split amounts.
 * @param split? Optional custom split amounts.
 * @param order? Optional order for split amounts (if fill was required)
 * @returns Array of split amounts.
 * @throws Error if split sum is greater than value or mint does not have keys for requested split.
 */
function splitAmount(value: number, keys: Keys): number[] {
  const split: number[] = [];
  // Denomination fill for the remaining value
  const sortedKeyAmounts = Object.keys(keys)
    .map((key) => Number(key))
    .sort((a, b) => b - a);
  if (!sortedKeyAmounts || sortedKeyAmounts.length === 0) {
    throw new Error('Cannot split amount, keyset is inactive or contains no keys');
  }
  for (const amt of sortedKeyAmounts) {
    if (amt <= 0) continue;
    // Calculate how many of amt fit into remaining value
    const requireCount = Math.floor(value / amt);
    // Add them to the split and reduce the target value by added amounts
    split.push(...Array<number>(requireCount).fill(amt));
    value -= amt * requireCount;
    // Break early once target is satisfied
    if (value === 0) break;
  }
  if (value !== 0) {
    throw new Error(`Unable to split remaining amount: ${value}`);
  }

  return split;
}
