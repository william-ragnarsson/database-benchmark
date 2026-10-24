import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  // `npx vite` for UI work, with the API from a running `compose up`.
  server: {
    // '/api/', not '/api': that would also send the client's own /api.ts module to the server.
    proxy: { '/api/': 'http://localhost:8080' },
  },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
});
