import { Amount } from '@cashu/cashu-ts';

import { ParentOwnedOperationError } from '../../models/Error.ts';
import { getSecretsFromSerializedOutputData } from '../../utils.ts';
import {
  assertMintSwapOperationParent,
  type MintSwapOperationParent,
} from '../MintSwapOperationParent.ts';
import type { MeltOperation } from '../melt/MeltOperation.ts';
import type { MintOperation } from '../mint/MintOperation.ts';

export interface ParentOwnedChildOperation {
  id: string;
  parent?: MintSwapOperationParent;
}

/**
 * Verify that a child is standalone or is being advanced by its recorded parent.
 *
 * The parent id is a composition guard, not an authentication mechanism. Parent-owned command
 * methods remain internal service seams.
 */
export function assertChildOperationAccess(
  operation: ParentOwnedChildOperation,
  expectedParentSwapOperationId?: string,
): void {
  const parent = operation.parent;
  if (!parent) {
    if (expectedParentSwapOperationId) {
      throw new Error(
        `Operation ${operation.id} is not owned by mint swap ${expectedParentSwapOperationId}`,
      );
    }
    return;
  }

  assertMintSwapOperationParent(parent);
  if (parent.id !== expectedParentSwapOperationId) {
    throw new ParentOwnedOperationError(operation.id, parent.id);
  }
}

/** Validate the durable authorization phase carried by a parent-owned melt child. */
export function assertParentOwnedMeltOperationInvariant(operation: MeltOperation): void {
  const parent = operation.parent;
  const phase = operation.parentExecutionPhase;
  if (!parent) {
    if (phase !== undefined) {
      throw new Error(`Standalone melt operation ${operation.id} cannot have a parent phase`);
    }
    return;
  }
  assertMintSwapOperationParent(parent);

  if (operation.state === 'executing') {
    if (phase === undefined) {
      throw new Error(`Parent-owned executing melt operation ${operation.id} requires a phase`);
    }
  } else if (
    operation.state === 'pending' ||
    operation.state === 'failed' ||
    operation.state === 'finalized'
  ) {
    if (phase !== 'melt_authorized') {
      throw new Error(
        `Parent-owned settled melt operation ${operation.id} requires melt authorization`,
      );
    }
  } else if (phase !== undefined) {
    throw new Error(
      `Melt operation ${operation.id} cannot retain a parent phase in ${operation.state}`,
    );
  }

  if (phase === 'pre_swap_authorized') {
    if (
      operation.state !== 'executing' ||
      !operation.needsSwap ||
      operation.swapOutputData === undefined
    ) {
      throw new Error(`Melt operation ${operation.id} has an invalid pre-swap authorization`);
    }
  }

  if (operation.state !== 'init') {
    assertUniqueNonEmpty(operation.inputProofSecrets, `Melt operation ${operation.id} inputs`);
    const changeSecrets = getSecretsFromSerializedOutputData(operation.changeOutputData);
    if (changeSecrets.sendSecrets.length > 0) {
      throw new Error(`Melt operation ${operation.id} change outputs cannot contain send outputs`);
    }
    assertUniqueNonEmpty(
      changeSecrets.keepSecrets,
      `Melt operation ${operation.id} change outputs`,
      {
        allowEmpty: true,
      },
    );
    if (operation.needsSwap) {
      if (!operation.swapOutputData) {
        throw new Error(`Melt operation ${operation.id} requires persisted swap outputs`);
      }
      const swapSecrets = getSecretsFromSerializedOutputData(operation.swapOutputData);
      assertUniqueNonEmpty(
        swapSecrets.sendSecrets,
        `Melt operation ${operation.id} swap send outputs`,
      );
      assertUniqueNonEmpty(
        [...swapSecrets.keepSecrets, ...swapSecrets.sendSecrets],
        `Melt operation ${operation.id} swap outputs`,
      );
    } else if (operation.swapOutputData !== undefined) {
      throw new Error(`Direct melt operation ${operation.id} cannot contain swap outputs`);
    }

    const requiredMeltAmount = operation.amount.add(operation.fee_reserve);
    if (operation.inputAmount.lessThan(requiredMeltAmount)) {
      throw new Error(`Melt operation ${operation.id} input amount cannot cover its quote`);
    }
    if (operation.needsSwap) {
      const swapOutputAmount = [
        ...operation.swapOutputData!.keep,
        ...operation.swapOutputData!.send,
      ].reduce(
        (total, output) => total.add(Amount.from(output.blindedMessage.amount)),
        Amount.zero(),
      );
      if (!swapOutputAmount.add(operation.swap_fee).equals(operation.inputAmount)) {
        throw new Error(`Melt operation ${operation.id} swap outputs do not conserve value`);
      }
      const swapSendAmount = operation.swapOutputData!.send.reduce(
        (total, output) => total.add(Amount.from(output.blindedMessage.amount)),
        Amount.zero(),
      );
      if (swapSendAmount.lessThan(requiredMeltAmount)) {
        throw new Error(`Melt operation ${operation.id} swap send outputs cannot cover its quote`);
      }
    } else if (!operation.swap_fee.isZero()) {
      throw new Error(`Direct melt operation ${operation.id} cannot contain a swap fee`);
    }
  }
}

/** Ensure a persisted parent-owned destination child is locked BOLT11/sat work. */
export function assertParentOwnedMintOperationInvariant(operation: MintOperation): void {
  if (!operation.parent) return;
  assertMintSwapOperationParent(operation.parent);
  if (
    operation.state === 'init' ||
    operation.method !== 'bolt11' ||
    operation.unit !== 'sat' ||
    operation.pubkey === undefined
  ) {
    throw new Error(`Parent-owned mint operation ${operation.id} must be locked BOLT11/sat work`);
  }
  const secrets = getSecretsFromSerializedOutputData(operation.outputData);
  if (secrets.sendSecrets.length > 0) {
    throw new Error(`Parent-owned mint operation ${operation.id} cannot contain send outputs`);
  }
  assertUniqueNonEmpty(secrets.keepSecrets, `Mint operation ${operation.id} outputs`);
  const outputAmount = operation.outputData.keep.reduce(
    (total, output) => total.add(Amount.from(output.blindedMessage.amount)),
    Amount.zero(),
  );
  if (!outputAmount.equals(operation.amount)) {
    throw new Error(`Parent-owned mint operation ${operation.id} output amount does not reconcile`);
  }
}

function assertUniqueNonEmpty(
  values: readonly string[],
  label: string,
  options: { allowEmpty?: boolean } = {},
): void {
  if (!options.allowEmpty && values.length === 0) throw new Error(`${label} cannot be empty`);
  if (values.some((value) => value.length === 0) || new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique non-empty values`);
  }
}

const PARENT_MINT_TRANSITIONS: Record<
  MintOperation['state'],
  ReadonlySet<MintOperation['state']>
> = {
  init: new Set(['pending']),
  pending: new Set(['executing', 'failed']),
  executing: new Set(['executing', 'finalized', 'failed']),
  finalized: new Set(),
  failed: new Set(),
};

const PARENT_MELT_TRANSITIONS: Record<
  MeltOperation['state'],
  ReadonlySet<MeltOperation['state']>
> = {
  init: new Set(['prepared', 'rolled_back']),
  prepared: new Set(['executing', 'rolled_back']),
  executing: new Set(['executing', 'pending', 'failed', 'finalized']),
  pending: new Set(['pending', 'failed', 'finalized', 'rolling_back']),
  failed: new Set(),
  finalized: new Set(),
  rolling_back: new Set(['rolled_back']),
  rolled_back: new Set(),
};

/** Enforce immutable economic facts and forward-only state for an owned destination child. */
export function assertParentOwnedMintOperationUpdate(
  current: MintOperation,
  next: MintOperation,
): void {
  if (current.parent?.id !== next.parent?.id || current.parent?.kind !== next.parent?.kind) {
    throw new Error(`Parent-owned mint parent ownership is immutable`);
  }
  if (!current.parent) return;
  assertParentOwnedMintOperationInvariant(next);
  assertOwnedBaseFields(current, next, 'mint');
  assertOwnedStateTransition(PARENT_MINT_TRANSITIONS, current, next, 'mint');
  if (current.state === 'init') return;

  const currentPending = current as Exclude<MintOperation, { state: 'init' }>;
  const nextPending = next as Exclude<MintOperation, { state: 'init' }>;
  assertImmutableValue(currentPending.quoteId, nextPending.quoteId, 'mint quote id');
  assertImmutableValue(
    currentPending.amount.toString(),
    nextPending.amount.toString(),
    'mint amount',
  );
  assertImmutableValue(currentPending.unit, nextPending.unit, 'mint unit');
  assertImmutableValue(currentPending.request, nextPending.request, 'mint request');
  assertImmutableValue(currentPending.expiry, nextPending.expiry, 'mint expiry');
  assertImmutableValue(currentPending.pubkey, nextPending.pubkey, 'mint quote key');
  assertImmutableValue(
    JSON.stringify(currentPending.outputData),
    JSON.stringify(nextPending.outputData),
    'mint deterministic outputs',
  );
}

/** Enforce immutable economic facts and forward-only state for an owned source child. */
export function assertParentOwnedMeltOperationUpdate(
  current: MeltOperation,
  next: MeltOperation,
): void {
  if (current.parent?.id !== next.parent?.id || current.parent?.kind !== next.parent?.kind) {
    throw new Error(`Parent-owned melt parent ownership is immutable`);
  }
  if (!current.parent) return;
  assertParentOwnedMeltOperationInvariant(next);
  assertOwnedBaseFields(current, next, 'melt');
  assertOwnedStateTransition(PARENT_MELT_TRANSITIONS, current, next, 'melt');
  if (current.state === 'init') return;

  const currentPrepared = current as Exclude<MeltOperation, { state: 'init' }>;
  const nextPrepared = next as Exclude<MeltOperation, { state: 'init' }>;
  for (const [left, right, name] of [
    [currentPrepared.quoteId, nextPrepared.quoteId, 'melt quote id'],
    [currentPrepared.amount.toString(), nextPrepared.amount.toString(), 'melt amount'],
    [
      currentPrepared.fee_reserve.toString(),
      nextPrepared.fee_reserve.toString(),
      'melt fee reserve',
    ],
    [currentPrepared.swap_fee.toString(), nextPrepared.swap_fee.toString(), 'melt swap fee'],
    [
      currentPrepared.inputAmount.toString(),
      nextPrepared.inputAmount.toString(),
      'melt input amount',
    ],
    [currentPrepared.needsSwap, nextPrepared.needsSwap, 'melt swap requirement'],
    [
      JSON.stringify(currentPrepared.inputProofSecrets),
      JSON.stringify(nextPrepared.inputProofSecrets),
      'melt input proofs',
    ],
    [
      JSON.stringify(currentPrepared.changeOutputData),
      JSON.stringify(nextPrepared.changeOutputData),
      'melt change outputs',
    ],
    [
      JSON.stringify(currentPrepared.swapOutputData),
      JSON.stringify(nextPrepared.swapOutputData),
      'melt swap outputs',
    ],
  ] as const) {
    assertImmutableValue(left, right, name);
  }
  const phaseOrder = { pre_swap_authorized: 1, melt_authorized: 2 } as const;
  const currentPhase = current.parentExecutionPhase ? phaseOrder[current.parentExecutionPhase] : 0;
  const nextPhase = next.parentExecutionPhase ? phaseOrder[next.parentExecutionPhase] : 0;
  if (nextPhase < currentPhase) {
    throw new Error('Parent-owned melt execution authorization cannot regress');
  }
}

function assertOwnedBaseFields(
  current: MintOperation | MeltOperation,
  next: MintOperation | MeltOperation,
  label: string,
): void {
  for (const [left, right, name] of [
    [current.id, next.id, 'id'],
    [current.parent?.kind, next.parent?.kind, 'parent kind'],
    [current.parent?.id, next.parent?.id, 'parent ownership'],
    [current.mintUrl, next.mintUrl, 'mint URL'],
    [current.unit, next.unit, 'unit'],
    [current.method, next.method, 'method'],
    [JSON.stringify(current.methodData), JSON.stringify(next.methodData), 'method data'],
    [current.createdAt, next.createdAt, 'createdAt'],
  ] as const) {
    assertImmutableValue(left, right, `${label} ${name}`);
  }
  if (next.updatedAt < current.updatedAt) {
    throw new Error(`Parent-owned ${label} updatedAt cannot regress`);
  }
}

function assertOwnedStateTransition<T extends { state: string }>(
  transitions: Record<string, ReadonlySet<string>>,
  current: T,
  next: T,
  label: string,
): void {
  if (current.state !== next.state && !transitions[current.state]?.has(next.state)) {
    throw new Error(`Illegal parent-owned ${label} transition: ${current.state} -> ${next.state}`);
  }
  if (current.state === next.state && !transitions[current.state]?.has(next.state)) {
    throw new Error(`Parent-owned ${label} state ${current.state} is immutable`);
  }
}

function assertImmutableValue(left: unknown, right: unknown, name: string): void {
  if (left !== right) throw new Error(`Parent-owned ${name} is immutable`);
}
