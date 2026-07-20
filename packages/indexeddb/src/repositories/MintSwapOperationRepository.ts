import { Amount } from '@cashu/cashu-ts';
import {
  assertMintSwapTransition,
  assertPreparedMintSwapImmutable,
  isAutomaticMintSwapState,
  isTerminalMintSwapState,
  validateMintSwapOperation,
  type MintSwapOperation,
  type MintSwapOperationState,
} from '@cashu/coco-core';
import type { MintSwapOperationRepository } from '@cashu/coco-core/adapter';

import { IdbDb, type MintSwapOperationRow } from '../lib/db.ts';

const STORE = 'coco_cashu_mint_swap_operations';

export class IdbMintSwapOperationRepository implements MintSwapOperationRepository {
  constructor(private readonly db: IdbDb) {}

  async create(operation: MintSwapOperation): Promise<void> {
    validateMintSwapOperation(operation);
    if (operation.revision !== 0) {
      throw new Error('New mint swap operation must start at revision 0');
    }
    await this.table().add(toRow(operation));
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const row = await this.table().get(id);
    return row ? fromRow(row) : null;
  }

  async getByState(state: MintSwapOperationState): Promise<MintSwapOperation[]> {
    const rows = await this.table().where('state').equals(state).toArray();
    return sortRows(rows).map(fromRow);
  }

  async getActive(): Promise<MintSwapOperation[]> {
    const rows = await this.table().toArray();
    return sortRows(rows)
      .map(fromRow)
      .filter((operation) => !isTerminalMintSwapState(operation.state));
  }

  async getDue(now: number, limit: number): Promise<MintSwapOperation[]> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Due time must be non-negative');
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Due limit must be non-negative');
    const rows = await this.table().toArray();
    return rows
      .map(fromRow)
      .filter(
        (operation) =>
          isAutomaticMintSwapState(operation.state) && (operation.retry.nextAttemptAt ?? 0) <= now,
      )
      .sort(
        (left, right) =>
          (left.retry.nextAttemptAt ?? 0) - (right.retry.nextAttemptAt ?? 0) ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
  }

  async getByDestinationMintOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.getByChild('destinationMintOperationId', id);
  }

  async getBySourceMeltOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.getByChild('sourceMeltOperationId', id);
  }

  async compareAndSet(operation: MintSwapOperation, expectedRevision: number): Promise<boolean> {
    return this.db.runTransaction('rw', [STORE], async () => {
      const currentRow = await this.table().get(operation.id);
      if (!currentRow || currentRow.revision !== expectedRevision) return false;
      const current = fromRow(currentRow);
      if (operation.revision !== expectedRevision + 1) {
        throw new Error('Mint swap compare-and-set must advance revision exactly once');
      }
      assertMintSwapTransition(current.state, operation.state);
      assertPreparedMintSwapImmutable(current, operation);
      validateMintSwapOperation(operation);
      await this.table().put(toRow(operation));
      return true;
    });
  }

  private async getByChild(
    index: 'destinationMintOperationId' | 'sourceMeltOperationId',
    id: string,
  ): Promise<MintSwapOperation | null> {
    const row = await this.table().where(index).equals(id).first();
    return row ? fromRow(row) : null;
  }

  private table() {
    return this.db.table<MintSwapOperationRow, string>(STORE);
  }
}

function sortRows(rows: MintSwapOperationRow[]): MintSwapOperationRow[] {
  return rows.sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function toRow(operation: MintSwapOperation): MintSwapOperationRow {
  return {
    id: operation.id,
    state: operation.state,
    revision: operation.revision,
    sourceMintUrl: operation.sourceMintUrl,
    destinationMintUrl: operation.destinationMintUrl,
    destinationMintOperationId: operation.destinationMintOperationId,
    sourceMeltOperationId: operation.sourceMeltOperationId,
    nextAttemptAt: operation.retry.nextAttemptAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    recordJson: JSON.stringify(serializeOperation(operation)),
  };
}

function serializeOperation(operation: MintSwapOperation): unknown {
  return {
    ...operation,
    destinationAmount: operation.destinationAmount.toString(),
    preparedPlan: operation.preparedPlan
      ? mapAmountsToStrings(operation.preparedPlan, [
          'sourceMeltAmount',
          'sourceFeeReserve',
          'sourcePreparationFee',
          'sourceMeltInputFee',
          'minimumSourceDebit',
          'maximumSourceDebit',
          'reservedSourceAmount',
        ])
      : undefined,
    settlement: operation.settlement
      ? mapAmountsToStrings(operation.settlement, [
          'sourcePaymentFee',
          'totalSourceFee',
          'sourceMeltChangeAmount',
          'sourceKeepAmount',
          'sourceReturnedAmount',
          'finalSourceDebit',
          'destinationAmountIssued',
        ])
      : undefined,
  };
}

function fromRow(row: MintSwapOperationRow): MintSwapOperation {
  const parsed = JSON.parse(row.recordJson) as Record<string, unknown> & {
    destinationAmount: string;
    preparedPlan?: Record<string, unknown>;
    settlement?: Record<string, unknown>;
  };
  return validateMintSwapOperation({
    ...parsed,
    destinationAmount: Amount.from(parsed.destinationAmount),
    preparedPlan: parsed.preparedPlan
      ? mapStringsToAmounts(parsed.preparedPlan, [
          'sourceMeltAmount',
          'sourceFeeReserve',
          'sourcePreparationFee',
          'sourceMeltInputFee',
          'minimumSourceDebit',
          'maximumSourceDebit',
          'reservedSourceAmount',
        ])
      : undefined,
    settlement: parsed.settlement
      ? mapStringsToAmounts(parsed.settlement, [
          'sourcePaymentFee',
          'totalSourceFee',
          'sourceMeltChangeAmount',
          'sourceKeepAmount',
          'sourceReturnedAmount',
          'finalSourceDebit',
          'destinationAmountIssued',
        ])
      : undefined,
  } as MintSwapOperation);
}

function mapAmountsToStrings<T extends object>(value: T, keys: readonly string[]): object {
  const result = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    if (result[key] !== undefined) result[key] = Amount.from(result[key] as Amount).toString();
  }
  return result;
}

function mapStringsToAmounts(value: Record<string, unknown>, keys: readonly string[]): object {
  const result = { ...value };
  for (const key of keys) {
    if (result[key] !== undefined) result[key] = Amount.from(result[key] as string);
  }
  return result;
}
