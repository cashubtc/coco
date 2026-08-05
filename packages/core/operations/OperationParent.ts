export interface MintSwapOperationParent {
  kind: 'mint-swap';
  id: string;
}

export interface MintBatchOperationParent {
  kind: 'mint-batch';
  id: string;
}

/** Durable reference to the operation that owns a child operation. */
export type OperationParent = MintSwapOperationParent | MintBatchOperationParent;
