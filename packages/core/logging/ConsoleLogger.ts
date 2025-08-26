import type { Logger, LogLevel } from './Logger.ts';

export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix = 'coco-cashu') {
    this.prefix = prefix;
  }

  error(message: string, ...meta: unknown[]): void {
    // eslint-disable-next-line no-console
    console.error(`[${this.prefix}] ERROR: ${message}`, ...meta);
  }
  warn(message: string, ...meta: unknown[]): void {
    // eslint-disable-next-line no-console
    console.warn(`[${this.prefix}] WARN: ${message}`, ...meta);
  }
  info(message: string, ...meta: unknown[]): void {
    // eslint-disable-next-line no-console
    console.info(`[${this.prefix}] INFO: ${message}`, ...meta);
  }
  debug(message: string, ...meta: unknown[]): void {
    // eslint-disable-next-line no-console
    if (
      process.env &&
      (process.env.DEBUG?.includes('coco-cashu') || process.env.NODE_ENV === 'development')
    ) {
      console.debug(`[${this.prefix}] DEBUG: ${message}`, ...meta);
    }
  }
  log(level: LogLevel, message: string, ...meta: unknown[]): void {
    switch (level) {
      case 'error':
        this.error(message, ...meta);
        break;
      case 'warn':
        this.warn(message, ...meta);
        break;
      case 'info':
        this.info(message, ...meta);
        break;
      case 'debug':
        this.debug(message, ...meta);
        break;
      default:
        this.info(message, ...meta);
    }
  }
  child(bindings: Record<string, unknown>): Logger {
    const name = [
      this.prefix,
      ...Object.entries(bindings).map(([k, v]) => `${k}=${String(v)}`),
    ].join(' ');
    return new ConsoleLogger(name);
  }
}
