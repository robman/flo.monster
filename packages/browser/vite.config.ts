import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { prerenderPlugin } from './vite-plugin-prerender';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  let httpsConfig: { key: Buffer; cert: Buffer } | undefined;

  if (isDev || mode === 'production') {
    try {
      httpsConfig = {
        key: fs.readFileSync(path.resolve(__dirname, 'certs/privkey.pem')),
        cert: fs.readFileSync(path.resolve(__dirname, 'certs/fullchain.pem')),
      };
    } catch {
      // Certs not found — dev will fail on HTTPS but won't crash config loading
    }
  }

  return {
    root: '.',
    plugins: isDev ? [] : [prerenderPlugin({
      skinDir: process.env.FLO_SKIN_DIR || path.resolve(__dirname, 'public/skins/flo-monster'),
    })],
    server: isDev ? {
      port: 5173,
      host: '0.0.0.0',
      https: httpsConfig,
      hmr: false,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    } : undefined,
    preview: {
      port: 4173,
      host: '0.0.0.0',
      https: httpsConfig,
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: true,
    },
  };
});
