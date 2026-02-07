import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4080',
      '/event': 'http://localhost:4080',
      '/health': 'http://localhost:4080',
      '/ws': {
        target: 'ws://localhost:4080',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
