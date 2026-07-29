import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { followLogFile, parseLogLineCount, tailLogLines } from "./logs";

describe("logs helpers", () => {
  test("tailLogLines returns the requested trailing lines", () => {
    expect(tailLogLines("one\ntwo\nthree\n", 2)).toBe("two\nthree\n");
    expect(tailLogLines("one\ntwo\nthree", 1)).toBe("three");
  });

  test("parseLogLineCount requires a positive integer", () => {
    expect(parseLogLineCount("25")).toBe(25);
    expect(() => parseLogLineCount("0")).toThrow("--lines must be a positive integer");
    expect(() => parseLogLineCount("2x")).toThrow("--lines must be a positive integer");
  });

  test("followLogFile continues after log rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cocod-logs-"));
    const logFile = join(dir, "daemon.log");
    await writeFile(logFile, "one\n", "utf8");

    const controller = new AbortController();
    const chunks: string[] = [];
    const followPromise = followLogFile(
      logFile,
      (chunk) => {
        chunks.push(chunk);
        controller.abort();
      },
      {
        startPosition: Buffer.byteLength("one\n"),
        pollIntervalMs: 10,
        signal: controller.signal,
      },
    );

    await Bun.sleep(20);
    await rename(logFile, `${logFile}.1`);
    await writeFile(logFile, "two\n", "utf8");

    await Promise.race([
      followPromise,
      Bun.sleep(500).then(() => {
        throw new Error("Timed out waiting for followed log output");
      }),
    ]);

    expect(chunks).toEqual(["two\n"]);
  });
});
