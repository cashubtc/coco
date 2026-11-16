/** Convert a Unix timestamp in seconds to milliseconds without rounding. */
export function unixSecondsToMilliseconds(unixSeconds: number): number {
  return unixSeconds * 1000;
}

/** Convert a Unix timestamp in milliseconds to whole seconds, rounding down. */
export function unixMillisecondsToSeconds(unixMilliseconds: number): number {
  return Math.floor(unixMilliseconds / 1000);
}
