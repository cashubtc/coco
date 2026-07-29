import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "coco-cashu-core";

import { LOG_FILE } from "./config.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface AppLogger extends Logger {
  flush(): Promise<void>;
}

export interface StructuredLoggerOptions {
  service?: string;
  logFile?: string;
  level?: LogLevel;
  maxBytes?: number;
  maxFiles?: number;
  mirrorToConsole?: boolean;
  bindings?: Record<string, unknown>;
  sharedState?: LoggerSharedState;
}

interface LoggerSharedState {
  queue: Promise<void>;
  initialization?: Promise<void>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_SERVICE = "cocod-daemon";
const REDACTED_KEYS = new Set([
  "authorization",
  "encryptedMnemonic",
  "invoice",
  "mnemonic",
  "passphrase",
  "request",
  "seed",
  "token",
  "xCashuHeader",
]);

const textEncoder = new TextEncoder();

export class StructuredLogger implements AppLogger {
  private readonly service: string;
  private readonly logFile: string;
  private readonly level: LogLevel;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly mirrorToConsole: boolean;
  private readonly bindings: Record<string, unknown>;
  private readonly sharedState: LoggerSharedState;

  constructor(options: StructuredLoggerOptions = {}) {
    this.service = options.service ?? DEFAULT_SERVICE;
    this.logFile = options.logFile ?? LOG_FILE;
    this.level = options.level ?? "info";
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.mirrorToConsole = options.mirrorToConsole ?? process.stdout.isTTY === true;
    this.bindings = options.bindings ?? {};
    this.sharedState = options.sharedState ?? { queue: Promise.resolve() };
  }

  error(message: string, ...meta: unknown[]): void {
    this.enqueue("error", message, meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this.enqueue("warn", message, meta);
  }

  info(message: string, ...meta: unknown[]): void {
    this.enqueue("info", message, meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    this.enqueue("debug", message, meta);
  }

  log(level: LogLevel, message: string, ...meta: unknown[]): void {
    this.enqueue(level, message, meta);
  }

  child(bindings: Record<string, unknown>): AppLogger {
    return new StructuredLogger({
      service: this.service,
      logFile: this.logFile,
      level: this.level,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      mirrorToConsole: this.mirrorToConsole,
      bindings: { ...this.bindings, ...bindings },
      sharedState: this.sharedState,
    });
  }

  async flush(): Promise<void> {
    await this.sharedState.queue;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.level];
  }

  private enqueue(level: LogLevel, message: string, meta: unknown[]): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const line = `${JSON.stringify(this.createEntry(level, message, meta))}\n`;
    this.sharedState.queue = this.sharedState.queue
      .then(async () => {
        await this.ensureInitialized();
        await this.rotateIfNeeded(line);
        await appendFile(this.logFile, line, "utf8");

        if (this.mirrorToConsole) {
          this.writeToConsole(level, line);
        }
      })
      .catch((error) => {
        this.writeToConsole(
          "error",
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            service: this.service,
            pid: process.pid,
            event: "logger.write_failed",
            error: serializeError(error),
          })}\n`,
        );
      });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.sharedState.initialization) {
      this.sharedState.initialization = mkdir(dirname(this.logFile), { recursive: true }).then(
        () => undefined,
      );
    }

    await this.sharedState.initialization;
  }

  private async rotateIfNeeded(nextLine: string): Promise<void> {
    const nextSize = textEncoder.encode(nextLine).byteLength;
    const currentSize = await getFileSize(this.logFile);

    if (currentSize === null || currentSize + nextSize <= this.maxBytes) {
      return;
    }

    if (this.maxFiles < 1) {
      await safeDelete(this.logFile);
      return;
    }

    await safeDelete(`${this.logFile}.${this.maxFiles}`);

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await safeRename(`${this.logFile}.${index}`, `${this.logFile}.${index + 1}`);
    }

    await safeRename(this.logFile, `${this.logFile}.1`);
  }

  private createEntry(level: LogLevel, message: string, meta: unknown[]): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      pid: process.pid,
      event: message,
      ...sanitizeRecord(this.bindings),
    };

    const [fields, remainingMeta] = extractFields(meta);
    Object.assign(entry, sanitizeRecord(fields));

    if (remainingMeta.length > 0) {
      entry.meta = remainingMeta.map((value) => sanitizeValue(value));
    }

    return entry;
  }

  private writeToConsole(level: LogLevel, line: string): void {
    if (level === "error" || level === "warn") {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }
}

export function createDaemonLogger(
  options: Partial<StructuredLoggerOptions> = {},
): StructuredLogger {
  return new StructuredLogger({
    service: DEFAULT_SERVICE,
    logFile: options.logFile ?? LOG_FILE,
    level: options.level ?? parseLogLevel(process.env.COCOD_LOG_LEVEL),
    maxBytes:
      options.maxBytes ?? parsePositiveInteger(process.env.COCOD_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxFiles:
      options.maxFiles ?? parsePositiveInteger(process.env.COCOD_LOG_MAX_FILES, DEFAULT_MAX_FILES),
    mirrorToConsole: options.mirrorToConsole,
    bindings: options.bindings,
  });
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause === undefined ? undefined : sanitizeValue(error.cause),
    };
  }

  return { message: String(error) };
}

function extractFields(meta: unknown[]): [Record<string, unknown>, unknown[]] {
  if (meta.length === 1 && isPlainObject(meta[0])) {
    return [meta[0], []];
  }

  return [{}, meta];
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = sanitizeValue(value, key);
  }

  return sanitized;
}

function sanitizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && REDACTED_KEYS.has(key)) {
    return "[REDACTED]";
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (depth >= 4) {
    return "[Truncated]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, undefined, depth + 1));
  }

  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};

    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      sanitized[nestedKey] = sanitizeValue(nestedValue, nestedKey, depth + 1);
    }

    return sanitized;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return `[Uint8Array:${value.byteLength}]`;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "error":
    case "warn":
    case "info":
    case "debug":
      return value;
    default:
      return "info";
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getFileSize(filePath: string): Promise<number | null> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function safeRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function safeDelete(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
