#!/usr/bin/env node
/**
 * Syntax gate for served CSS.
 *
 * Nothing else parses the stylesheets: a dropped brace silently deletes every
 * rule after it and the page still loads, so CI stays green. This checks
 * structural balance (blocks, parentheses, strings, comments) with source
 * positions, and flags custom properties that are used without a fallback but
 * never defined anywhere in the shipped CSS.
 *
 *   node tools/check-css.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAIRS = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = { '}': '{', ')': '(', ']': '[' };

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

function position(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return `${line}:${column}`;
}

function checkStructure(text, label, problems) {
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) {
        problems.push(`${label}:${position(text, index)}: unterminated comment`);
        return;
      }
      index = end + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === char) break;
        if (text[cursor] === '\n') {
          problems.push(`${label}:${position(text, index)}: newline inside a string`);
          return;
        }
        cursor += 1;
      }
      if (cursor >= text.length) {
        problems.push(`${label}:${position(text, index)}: unterminated string`);
        return;
      }
      index = cursor + 1;
      continue;
    }

    if (PAIRS[char]) {
      stack.push({ char, index });
    } else if (CLOSERS[char]) {
      const open = stack.pop();
      if (!open) {
        problems.push(`${label}:${position(text, index)}: unexpected '${char}'`);
        return;
      }
      if (open.char !== CLOSERS[char]) {
        problems.push(
          `${label}:${position(text, index)}: '${char}' closes '${open.char}' opened at ${position(text, open.index)}`
        );
        return;
      }
    }
    index += 1;
  }

  for (const open of stack) {
    problems.push(`${label}:${position(text, open.index)}: unclosed '${open.char}'`);
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function main() {
  const files = [
    path.join(ROOT, 'site-chrome.css'),
    path.join(ROOT, 'pages.css'),
    path.join(ROOT, 'analytics-chart.css'),
    ...walk(path.join(ROOT, 'styles')),
  ].filter((file) => fs.existsSync(file));

  if (!files.length) {
    console.error('No CSS files found to check.');
    process.exit(1);
  }

  const problems = [];
  const texts = new Map();
  const defined = new Set();
  let rules = 0;

  for (const file of files) {
    const label = path.relative(ROOT, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    texts.set(label, text);
    checkStructure(text, label, problems);
    const stripped = stripComments(text);
    rules += (stripped.match(/\{/g) || []).length;
    for (const match of stripped.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(match[1]);
  }

  for (const [label, text] of texts) {
    const stripped = stripComments(text);
    for (const match of stripped.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(,|\))/g)) {
      if (match[2] === ',') continue; // a fallback makes the reference safe
      if (!defined.has(match[1])) {
        problems.push(`${label}:${position(text, match.index)}: ${match[1]} is used but never defined`);
      }
    }
  }

  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`${problems.length} CSS problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  console.log(`CSS OK: ${files.length} file(s), ${rules} rule block(s), all custom properties defined.`);
}

main();
