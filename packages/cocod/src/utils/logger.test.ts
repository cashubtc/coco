import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredLogger } from "./logger";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { force: true, recursive: true });
  }
});

describe("StructuredLogger", () => {
  test("writes structured log entries and redacts sensitive fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cocod-logger-"));
    tempDirs.push(dir);

    const logFile = join(dir, "daemon.log");
    const logger = new StructuredLogger({
      logFile,
      mirrorToConsole: false,
      bindings: { component: "daemon" },
    });

    logger.info("wallet.unlock_requested", {
      mintUrl: "https://mint.example.com/Bitcoin",
      passphrase: "secret-passphrase",
    });
    await logger.flush();

    const content = await readFile(logFile, "utf8");
    const entry = JSON.parse(content.trim()) as Record<string, unknown>;

    expect(entry.event).toBe("wallet.unlock_requested");
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("daemon");
    expect(entry.passphrase).toBe("[REDACTED]");
    expect(entry.mintUrl).toBe("https://mint.example.com/Bitcoin");
  });

  test("rotates files and respects retention count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cocod-logger-"));
    tempDirs.push(dir);

    const logFile = join(dir, "daemon.log");
    const logger = new StructuredLogger({
      logFile,
      maxBytes: 250,
      maxFiles: 2,
      mirrorToConsole: false,
    });

    for (let index = 0; index < 12; index += 1) {
      logger.info("rotation.test", {
        index,
        payload: "x".repeat(80),
      });
    }
    await logger.flush();

    const current = await stat(logFile);
    const rotatedOne = await stat(`${logFile}.1`);
    const rotatedTwo = await stat(`${logFile}.2`);

    expect(current.size).toBeGreaterThan(0);
    expect(rotatedOne.size).toBeGreaterThan(0);
    expect(rotatedTwo.size).toBeGreaterThan(0);

    const currentContent = await readFile(logFile, "utf8");
    expect(currentContent).toContain('"index":11');

    await expect(stat(`${logFile}.3`)).rejects.toThrow();
  });
});
