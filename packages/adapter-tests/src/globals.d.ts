interface Crypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

declare const crypto: Crypto;

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): number;
