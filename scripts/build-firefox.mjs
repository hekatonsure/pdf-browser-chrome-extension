#!/usr/bin/env node
// Builds a Firefox-specific bundle at dist/firefox/ by copying extension/
// and swapping in manifest.firefox.json as manifest.json.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const dst = path.join(root, 'dist', 'firefox');

fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });

const ffManifestPath = path.join(dst, 'manifest.firefox.json');
const manifestPath = path.join(dst, 'manifest.json');
fs.renameSync(ffManifestPath, manifestPath);

console.log(`Firefox bundle ready: ${path.relative(root, dst)}`);
console.log('Load via about:debugging → "This Firefox" → "Load Temporary Add-on" → pick dist/firefox/manifest.json');
