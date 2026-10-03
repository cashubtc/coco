import path from 'node:path';

/** Map source files to Monaco's virtual filesystem on any build host. */
export function virtualTypePath(root: string, filename: string): string {
  // TypeScript can return forward slashes even when the host uses backslashes.
  root = path.posix.normalize(root.replaceAll('\\', '/'));
  filename = path.posix.normalize(filename.replaceAll('\\', '/'));
  const core = path.posix.join(root, 'packages/core');
  if (filename.startsWith(`${core}/`))
    return `node_modules/@cashu/coco-core/${path.posix.relative(core, filename)}`;
  const marker = filename.lastIndexOf('/node_modules/');
  return marker >= 0
    ? `node_modules/${filename.slice(marker + 14)}`
    : `workspace/${path.posix.relative(root, filename)}`;
}
