import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  server: { port: 5173, open: false },
});
