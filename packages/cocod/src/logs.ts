import { stat } from "node:fs/promises";

export const DEFAULT_LOG_LINES = 50;
const DEFAULT_POLL_INTERVAL_MS = 250;

interface FollowLogOptions {
  startPosition?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function parseLogLineCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("--lines must be a positive integer");
  }

  const lineCount = Number.parseInt(value, 10);

  if (!Number.isInteger(lineCount) || lineCount < 1) {
    throw new Error("--lines must be a positive integer");
  }

  return lineCount;
}

export function tailLogLines(content: string, lineCount: number): string {
  if (content.length === 0) {
    return "";
  }

  const hasTrailingNewline = content.endsWith("\n");
  const normalizedContent = hasTrailingNewline ? content.slice(0, -1) : content;

  if (normalizedContent.length === 0) {
    return content;
  }

  const lines = normalizedContent.split("\n");
  const tailedContent = lines.slice(-lineCount).join("\n");

  return hasTrailingNewline ? `${tailedContent}\n` : tailedContent;
}

export async function readRecentLogText(filePath: string, lineCount: number): Promise<string> {
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    throw new Error(`Log file not found: ${filePath}`);
  }

  return tailLogLines(await file.text(), lineCount);
}

export async function getLogFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isNotFoundError(error)) {
      return 0;
    }

    throw error;
  }
}

export async function followLogFile(
  filePath: string,
  onChunk: (chunk: string) => void,
  options: FollowLogOptions = {},
): Promise<void> {
  const { startPosition = 0, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, signal } = options;
  let position = startPosition;
  let inode: number | undefined;

  while (!signal?.aborted) {
    let currentSize = 0;

    try {
      const fileStat = await stat(filePath);
      currentSize = fileStat.size;

      if (inode !== undefined && fileStat.ino !== inode) {
        position = 0;
      }

      inode = fileStat.ino;
    } catch (error) {
      if (isNotFoundError(error)) {
        inode = undefined;
        position = 0;
        await Bun.sleep(pollIntervalMs);
        continue;
      }

      throw error;
    }

    if (currentSize < position) {
      position = 0;
    }

    if (currentSize > position) {
      const chunk = await Bun.file(filePath).slice(position, currentSize).text();

      if (chunk.length > 0) {
        onChunk(chunk);
      }

      position = currentSize;
    }

    await Bun.sleep(pollIntervalMs);
  }
}
