import { V1HttpError, type V1Runtime } from '../contract.js';

export type RunningSession = NonNullable<ReturnType<V1Runtime['getRunningSession']>>;

export function requireRunningSession(runtime: V1Runtime) {
  const session = runtime.getRunningSession();
  if (session) {
    return session;
  }

  const status = runtime.getStatus();
  if (!status.wallet) {
    throw new V1HttpError({
      status: 409,
      code: 'wallet_not_configured',
      message: 'No Wallet is configured',
      retryable: false,
    });
  }
  if (status.cocoSession.state === 'starting' || status.cocoSession.state === 'stopping') {
    throw new V1HttpError({
      status: 503,
      code: 'session_transition_in_progress',
      message: `The Coco Session is ${status.cocoSession.state}`,
      retryable: true,
      details: { state: status.cocoSession.state },
      headers: { 'Retry-After': '1' },
    });
  }
  if (status.cocoSession.state === 'failed') {
    throw new V1HttpError({
      status: 503,
      code: 'session_restart_required',
      message: 'The Cocod Process must be restarted',
      retryable: false,
    });
  }
  if (status.seedAccess?.state === 'locked') {
    throw new V1HttpError({
      status: 423,
      code: 'wallet_locked',
      message: 'Wallet Seed Access is locked',
      retryable: false,
    });
  }
  throw new V1HttpError({
    status: 503,
    code: 'session_stopped',
    message: 'The Coco Session is stopped',
    retryable: true,
  });
}
