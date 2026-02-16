#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '../package.json');
const distDir = resolve(__dirname, '../dist');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

// Compute content hash from dist assets
function hashDirectory(dir) {
  const hash = createHash('sha256');
  try {
    const files = readdirSync(dir, { recursive: true });
    for (const file of files) {
      const fullPath = resolve(dir, file);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          hash.update(readFileSync(fullPath));
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // dist dir might not exist yet
  }
  return hash.digest('hex').slice(0, 12);
}

const version = {
  version: pkg.version,
  buildTime: new Date().toISOString(),
  contentHash: hashDirectory(distDir),
};

const outPath = resolve(distDir, 'version.json');
writeFileSync(outPath, JSON.stringify(version, null, 2));
console.log(`Generated ${outPath}:`, version);
