#!/usr/bin/env node
/**
 * Small, dependency-free dead-export gate.
 *
 * This is deliberately narrower than a bundler's tree-shaking analysis: it
 * checks every named export in functions/ for at least one reference outside
 * its own declaration. That catches the common regression here -- a helper is
 * removed from the router but its export is left behind -- without failing on
 * dynamic Page Functions entry points.
 *
 * Usage: node tools/check-dead-code.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const roots = ['functions'];
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.html', '.ts', '.tsx']);
const skipDirs = new Set(['node_modules', '.git', '.wrangler', '.pages-dist', 'data']);
const allow = new Set([
  // Pages Functions discovers these by filename/export convention.
  'onRequest',
  'onRequestGet',
  'onRequestPost',
  'onRequestPut',
  'onRequestDelete',
  'onRequestPatch',
  'onScheduled',
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (sourceExtensions.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const sourceFiles = roots.flatMap((dir) => walk(path.join(root, dir)));
const corpusFiles = [
  ...walk(root).filter((file) => !file.includes(`${path.sep}scripts${path.sep}`)),
  ...walk(path.join(root, 'scripts')),
];
const corpus = corpusFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

const declarations = [];
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    let match = line.match(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (match) declarations.push({ name: match[1], file, line: index + 1 });
    match = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (match) declarations.push({ name: match[1], file, line: index + 1 });
    match = line.match(/^\s*export\s*\{([^}]+)\}/);
    if (match) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declarations.push({ name, file, line: index + 1 });
      }
    }
  });
}

const unused = [];
for (const declaration of declarations) {
  if (allow.has(declaration.name)) continue;
  const matches = corpus.match(new RegExp(`\\b${declaration.name.replace(/[$]/g, '\\$&')}\\b`, 'g'));
  if (!matches || matches.length <= 1) unused.push(declaration);
}

if (unused.length) {
  for (const item of unused) {
    console.error(`${path.relative(root, item.file)}:${item.line}: unused export ${item.name}`);
  }
  console.error(`\n${unused.length} unused export(s) found. Remove them or add a documented allowlist entry.`);
  process.exit(1);
}

console.log(`Checked ${declarations.length} named exports across ${sourceFiles.length} function files; no dead exports.`);
