import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// https://vite.dev/config/
export default defineConfig({
  build: {
    lib: {
      entry: './src/lib/index.ts',
      name: 'coco-cashu-react',
      fileName: 'index',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'coco-cashu-core'],
    },
  },
  plugins: [react(), dts({ tsconfigPath: './tsconfig.app.json', rollupTypes: true })],
});
