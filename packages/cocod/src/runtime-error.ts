/** Stable error codes emitted by the transport-independent Cocod lifecycle runtime. */
export type CocodRuntimeErrorCode =
  | 'invalid_mint_url'
  | 'invalid_mnemonic'
  | 'invalid_wallet_config'
  | 'passphrase_required'
  | 'session_restart_required'
  | 'session_transition_in_progress'
  | 'wallet_already_configured'
  | 'wallet_not_configured'
  | 'wallet_unlock_failed';

/** Stable lifecycle failure raised by the transport-independent Cocod runtime. */
export class CocodRuntimeError extends Error {
  constructor(
    readonly code: CocodRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CocodRuntimeError';
  }
}
