import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(
  fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8')
) as { version?: string };
const appVersion = String(pkgJson.version || '1.0.2').trim();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@shared': path.resolve(rootDir, 'src/shared'),
      '@main': path.resolve(rootDir, 'src/main'),
      '@renderer': path.resolve(rootDir, 'src/renderer'),
      '@mobile': path.resolve(rootDir, 'src/mobile'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 20000,
  },
});
