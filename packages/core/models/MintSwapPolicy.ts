export const DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS = 120;
export const MIN_MINT_SWAP_DISPATCH_WINDOW_SECONDS = 30;

export interface MintSwapDispatchWindowInput {
  expiries: Array<number | null | undefined>;
  now?: number;
  requiredWindowSeconds?: number;
}

export interface MintSwapDispatchWindow {
  dispatchDeadline: number;
  remainingSeconds: number;
  requiredWindowSeconds: number;
  canDispatch: boolean;
}

/**
 * Evaluates the earliest usable quote/invoice deadline before source payment.
 * Expiries and `now` use Unix seconds; zero/null expiries are no-expiry sentinels.
 */
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

  const deadlines: number[] = [];
  for (const expiry of input.expiries) {
    if (expiry === null || expiry === undefined || expiry === 0) {
      continue;
    }
    if (!Number.isSafeInteger(expiry) || expiry < 0) {
      throw new Error('Mint swap expiry must be a positive Unix timestamp or a no-expiry sentinel');
    }
    deadlines.push(expiry);
  }
  if (deadlines.length === 0) {
    throw new Error('Mint swap dispatch requires at least one finite quote or invoice expiry');
  }

  const dispatchDeadline = Math.min(...deadlines);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const remainingSeconds = dispatchDeadline - now;
  return {
    dispatchDeadline,
    remainingSeconds,
    requiredWindowSeconds,
    canDispatch: remainingSeconds >= requiredWindowSeconds,
  };
}
