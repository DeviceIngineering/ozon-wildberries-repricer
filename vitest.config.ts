import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Absolute path: a relative one resolves against the outer workspace when
    // this project sits inside another checkout.
    setupFiles: [fileURLToPath(new URL('./src/test-setup.ts', import.meta.url))],
    passWithNoTests: true,
  },
});
