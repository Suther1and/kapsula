import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

const pkgJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
) as { version?: string };
const APP_VERSION = String(pkgJson.version || '1.0.2').trim();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  base: './',
  root: path.resolve(__dirname, 'src/mobile'),
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@mobile': path.resolve(__dirname, 'src/mobile'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/mobile'),
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 40,
            },
            {
              name: 'supabase',
              test: /[\\/]node_modules[\\/]@supabase[\\/]/,
              priority: 35,
            },
            {
              name: 'motion',
              test: /[\\/]node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/,
              priority: 30,
            },
            {
              name: 'icons',
              test: /[\\/]node_modules[\\/]@phosphor-icons[\\/]/,
              priority: 25,
            },
            {
              name: 'editor-tiptap',
              test: /[\\/]node_modules[\\/](@tiptap|prosemirror-|lowlight|highlight\.js|marked|orderedmap|rope-sequence|w3c-keyname)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
