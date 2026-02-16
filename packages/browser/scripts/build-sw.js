#!/usr/bin/env node
import { build } from 'esbuild';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// Recursively collect all files in dist/ for precache manifest.
// Excludes: sw.js (SW shouldn't cache itself), sourcemaps, index.html (precached as /)
const SKIP = new Set(['sw.js', 'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'version.txt']);

function collectFiles(dir, base = dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = '/' + relative(base, full);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, base));
    } else if (!entry.endsWith('.map') && !SKIP.has(entry) && rel !== '/index.html') {
      results.push(rel);
    }
  }
  return results;
}

const assets = collectFiles('dist');

await build({
  entryPoints: ['src/shell/sw.ts'],
  bundle: true,
  outfile: 'dist/sw.js',
  format: 'iife',
  target: 'es2022',
  minify: process.env.NODE_ENV === 'production',
  define: {
    '__PRECACHE_ASSETS__': JSON.stringify(assets),
    '__API_BASE_URL__': JSON.stringify(process.env.VITE_API_BASE_URL || ''),
  },
});

console.log(`Built dist/sw.js (precaching ${assets.length} build assets)`);
