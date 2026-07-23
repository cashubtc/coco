/** @experimental This interface may change without notice. */
export type PaymentAmount = {
  value: number;
  unit: string;
};

/** @experimental This interface may change without notice. */
export type IncomingPayment = {
  id: string;
  request: string;
  amount: PaymentAmount;
  state: 'UNPAID' | 'PAID';
};

/** @experimental This interface may change without notice. */
export type OutgoingPayment = {
  quoteId: string;
  request: string;
  amount: PaymentAmount;
  fee: PaymentAmount;
  state: 'UNPAID' | 'PENDING' | 'PAID';
};

/** @experimental This interface may change without notice. */
export type PaymentProcessorSnapshot = {
  incoming: IncomingPayment[];
  outgoing: OutgoingPayment[];
  protocolVersion?: string;
};

/** @experimental Options for starting a local controllable CDK mint. */
export type ExperimentalTestMintOptions = {
  /** HTTP port for mintd. An available port is selected by default. */
  mintPort?: number;
  /** gRPC port for the payment processor. An available port is selected by default. */
  processorPort?: number;
  /** Parent directory for temporary mint state. Defaults to the OS temporary directory. */
  scratchRoot?: string;
  /** Maximum time to wait for mintd to become reachable. Defaults to 20 seconds. */
  startupTimeoutMs?: number;
  /** Forward mintd logs to the current process. */
  showMintLogs?: boolean;
};
