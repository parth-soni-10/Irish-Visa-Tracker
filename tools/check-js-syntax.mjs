#!/usr/bin/env node
/** Parse every served/browser/Worker JavaScript file before deployment. */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = process.cwd();
const skipDirs = new Set(['node_modules', '.git', '.wrangler', '.pages-dist', 'data', 'test-results']);
const extensions = new Set(['.js', '.mjs', '.cjs']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (extensions.has(path.extname(entry.name)) && !entry.name.endsWith('.min.js')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'functions')),
  ...walk(path.join(root, 'scripts')),
  ...walk(path.join(root, 'tools')),
  ...walk(path.join(root, 'monitoring')),
  ...fs.readdirSync(root)
    .filter((name) => extensions.has(path.extname(name)) && !name.endsWith('.min.js'))
    .map((name) => path.join(root, name)),
];

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(result.stderr || result.stdout || `Syntax check failed: ${file}`);
  }
}

if (failed) {
  console.error(`${failed} JavaScript file(s) failed parsing.`);
  process.exit(1);
}

console.log(`Parsed ${files.length} JavaScript files.`);
