export const DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS = 120;
export const MIN_MINT_SWAP_DISPATCH_WINDOW_SECONDS = 30;

export interface MintSwapDispatchWindowInput {
  expiries: Array<number | null | undefined>;
  now?: number;
  requiredWindowSeconds?: number;
}

export interface MintSwapDispatchWindow {
  dispatchDeadlineSeconds: number;
  remainingSeconds: number;
  requiredWindowSeconds: number;
  canDispatch: boolean;
}

/** Evaluate the earliest finite quote deadline before source payment. */
export function evaluateMintSwapDispatchWindow(
  input: MintSwapDispatchWindowInput,
): MintSwapDispatchWindow {
  const requiredWindowSeconds =
    input.requiredWindowSeconds ?? DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS;
  if (
    !Number.isSafeInteger(requiredWindowSeconds) ||
    requiredWindowSeconds < MIN_MINT_SWAP_DISPATCH_WINDOW_SECONDS
  ) {
    throw new Error(
      `Mint swap dispatch window must be at least ${MIN_MINT_SWAP_DISPATCH_WINDOW_SECONDS} seconds`,
    );
  }
  const deadlines = input.expiries.filter(
    (expiry): expiry is number => expiry !== null && expiry !== undefined && expiry !== 0,
  );
  if (
    deadlines.some((expiry) => !Number.isSafeInteger(expiry) || expiry < 0) ||
    deadlines.length === 0
  ) {
    throw new Error('Mint swap dispatch requires valid finite quote expiry evidence');
  }
  const dispatchDeadlineSeconds = Math.min(...deadlines);
  const remainingSeconds = dispatchDeadlineSeconds - (input.now ?? Math.floor(Date.now() / 1_000));
  return {
    dispatchDeadlineSeconds,
    remainingSeconds,
    requiredWindowSeconds,
    canDispatch: remainingSeconds >= requiredWindowSeconds,
  };
}
