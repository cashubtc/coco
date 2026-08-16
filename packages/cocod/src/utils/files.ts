import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Creates or corrects cocod's private state directory. */
export async function ensurePrivateStateDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

/** Creates a secret-bearing file with private permissions, or corrects an existing file. */
export async function ensureSecretFile(path: string): Promise<void> {
  await ensurePrivateStateDirectory(path);
  const file = await open(path, 'a', 0o600);
  await file.close();
  await chmod(path, 0o600);
}

/** Atomically replaces a secret-bearing file without a wider-permission creation window. */
export async function writeSecretFile(path: string, contents: string): Promise<void> {
  await ensurePrivateStateDirectory(path);
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;

  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(contents, { encoding: 'utf8' });
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
