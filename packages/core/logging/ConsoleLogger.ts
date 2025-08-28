import type { Logger, LogLevel } from './Logger.ts';

type ConsoleLoggerOptions = {
  level?: LogLevel; // minimum level to log
};

export class ConsoleLogger implements Logger {
  private prefix: string;
  private level: LogLevel;

  private static readonly levelPriority: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };

  constructor(prefix = 'coco-cashu', options: ConsoleLoggerOptions = {}) {
    this.prefix = prefix;
    this.level = options.level ?? 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    return ConsoleLogger.levelPriority[level] <= ConsoleLogger.levelPriority[this.level];
  }

  error(message: string, ...meta: unknown[]): void {
    if (!this.shouldLog('error')) return;
    // eslint-disable-next-line no-console
    console.error(`[${this.prefix}] ERROR: ${message}`, ...meta);
  }
  warn(message: string, ...meta: unknown[]): void {
    if (!this.shouldLog('warn')) return;
    // eslint-disable-next-line no-console
    console.warn(`[${this.prefix}] WARN: ${message}`, ...meta);
  }
  info(message: string, ...meta: unknown[]): void {
    if (!this.shouldLog('info')) return;
    // eslint-disable-next-line no-console
    console.info(`[${this.prefix}] INFO: ${message}`, ...meta);
  }
  debug(message: string, ...meta: unknown[]): void {
    if (!this.shouldLog('debug')) return;
    // eslint-disable-next-line no-console
    console.debug(`[${this.prefix}] DEBUG: ${message}`, ...meta);
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
    return new ConsoleLogger(name, { level: this.level });
  }
}
