import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

const pkgJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
) as { version?: string };
const APP_VERSION = String(pkgJson.version || '1.0.2').trim();

const PROD_META_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' kapsula-media: data: blob:; media-src 'self' kapsula-media: blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

function prodCspPlugin(): Plugin {
  return {
    name: 'kapsula-prod-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) return html;
        if (html.includes('http-equiv="Content-Security-Policy"')) return html;
        return html.replace(
          '</head>',
          `    <meta http-equiv="Content-Security-Policy" content="${PROD_META_CSP}" />\n  </head>`
        );
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), prodCspPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  base: './',
  root: path.resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome134',
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
              name: 'overlayscrollbars',
              test: /[\\/]node_modules[\\/]overlayscrollbars(?:-react)?[\\/]/,
              priority: 22,
            },
            {
              name: 'vault-ui',
              test: /[\\/]node_modules[\\/](@base-ui|@floating-ui|sonner|@number-flow|@formkit)[\\/]/,
              priority: 15,
            },
            {
              name: 'editor-tiptap',
              test: /[\\/]node_modules[\\/](@tiptap|prosemirror-|lowlight|highlight\.js|marked|orderedmap|rope-sequence|w3c-keyname)[\\/]/,
              priority: 20,
            },
            {
              name: 'hud-cmdk',
              test: /[\\/]node_modules[\\/]cmdk[\\/]/,
              priority: 15,
            },
          ],
        },
      },
    },
  },
});
