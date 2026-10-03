import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typeBundle } from './type-bundle';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const id = 'virtual:playground-types';
const types: Plugin = {
  name: 'playground-workspace-types',
  resolveId: (name) => (name === id ? `\0${id}` : undefined),
  load(name) {
    if (name !== `\0${id}`) return;
    const bundle = typeBundle(root);
    for (const file of bundle.dependencies) this.addWatchFile(file);
    return `export const libs = ${JSON.stringify(bundle.libs)}; export const paths = ${JSON.stringify(bundle.paths)}; export const eventNames = ${JSON.stringify(bundle.events)};`;
  },
  handleHotUpdate(context) {
    if (context.file.startsWith(path.join(root, 'packages/core'))) {
      context.server.ws.send({ type: 'full-reload' });
      return [];
    }
  },
};
export default defineConfig({
  root: directory,
  base: './',
  plugins: [types],
  resolve: {
    alias: [
      {
        find: /^@cashu\/coco-core\/adapter$/,
        replacement: path.join(root, 'packages/core/adapter.ts'),
      },
      {
        find: /^@cashu\/coco-core\/plugin$/,
        replacement: path.join(root, 'packages/core/plugin.ts'),
      },
      { find: /^@cashu\/coco-core$/, replacement: path.join(root, 'packages/core/index.ts') },
      { find: /^@core\/(.*)$/, replacement: `${root}/packages/core/$1` },
    ],
  },
  worker: { format: 'es', plugins: () => [types] },
  build: {
    outDir: path.join(root, 'dist/playground'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
    // History parsing shares the TypeScript package with the evaluator. Keep
    // its browser bundle separate from the editor and workspace type data.
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes('/typescript/lib/typescript.js') ? 'typescript-parser' : undefined,
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { allow: [root] } },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
