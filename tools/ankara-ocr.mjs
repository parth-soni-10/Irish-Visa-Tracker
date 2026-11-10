/**
 * Annex OCR helpers for scanned embassy PDFs.
 *
 * CI uses Poppler's `pdftoppm` to render pages at 300 DPI and the Tesseract
 * CLI with single-column page segmentation. A Node fallback keeps local runs
 * usable when those binaries are absent, using the same page segmentation.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const OCR_LANG = process.env.TESSERACT_LANG || 'eng';
const OCR_PSM = '4';
const DEFAULT_DPI = 300;

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120000,
      ...options,
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    throw new Error(`${command} failed: ${stderr || error.message}`);
  }
}

function commandAvailable(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function resolvePoppler() {
  if (process.env.PDFTOPPM) return process.env.PDFTOPPM;
  const bundled = path.resolve(process.cwd(), 'node_modules', 'pdf-poppler', 'lib', 'win', 'poppler-0.51', 'bin', 'pdftoppm.exe');
  return fs.existsSync(bundled) ? bundled : 'pdftoppm';
}

function cliTools() {
  const pdftoppm = resolvePoppler();
  const tesseract = process.env.TESSERACT || 'tesseract';
  if (!commandAvailable(pdftoppm, ['-v']) || !commandAvailable(tesseract, ['--version'])) return null;
  return { pdftoppm, tesseract };
}

function pageNumber(file) {
  const match = file.match(/-(\d+)\.png$/);
  return match ? Number(match[1]) : 0;
}

async function ocrWithCli(buffer, { dpi, pdftoppm, tesseract }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irish-visa-ocr-'));
  try {
    const pdfPath = path.join(tempDir, 'source.pdf');
    const prefix = path.join(tempDir, 'page');
    fs.writeFileSync(pdfPath, buffer);
    run(pdftoppm, ['-r', String(dpi), '-png', pdfPath, prefix], { cwd: tempDir });

    const images = fs.readdirSync(tempDir)
      .filter((file) => /^page-\d+\.png$/.test(file))
      .sort((a, b) => pageNumber(a) - pageNumber(b));
    if (!images.length) throw new Error('pdftoppm produced no page images');

    const pages = images.map((image) =>
      run(tesseract, [path.join(tempDir, image), 'stdout', '-l', OCR_LANG, '--psm', OCR_PSM], {
        cwd: tempDir,
      })
    );
    return {
      text: pages.join('\n\f\n'),
      pages: pages.length,
      dpi,
      engine: 'poppler+tesseract',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function ocrWithNode(buffer, { dpi }) {
  const { createWorker, PSM } = await import('tesseract.js');
  const pdftoppm = resolvePoppler();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irish-visa-ocr-'));
  try {
    const pdfPath = path.join(tempDir, 'source.pdf');
    const prefix = path.join(tempDir, 'page');
    fs.writeFileSync(pdfPath, buffer);
    run(pdftoppm, ['-r', String(dpi), '-png', pdfPath, prefix], { cwd: tempDir });

    const images = fs.readdirSync(tempDir)
      .filter((file) => /^page-\d+\.png$/.test(file))
      .sort((a, b) => pageNumber(a) - pageNumber(b));
    if (!images.length) throw new Error('pdftoppm produced no page images');

    const worker = await createWorker(OCR_LANG);
    const pages = [];
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
        user_defined_dpi: String(dpi),
      });
      for (const image of images) {
        const result = await worker.recognize(path.join(tempDir, image));
        pages.push(result.data.text || '');
      }
    } finally {
      await worker.terminate().catch(() => {});
    }

    return {
      text: pages.join('\n\f\n'),
      pages: pages.length,
      dpi,
      engine: 'poppler+tesseract.js',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function ocrPdfBuffer(buffer, options = {}) {
  const dpi = Number(options.dpi) || DEFAULT_DPI;
  const tools = options.engine === 'node' ? null : cliTools();
  if (tools) return ocrWithCli(buffer, { ...tools, dpi });
  return ocrWithNode(buffer, { dpi });
}

/**
 * Parse Tesseract's output. Ankara's table is two columns; PSM 4 normally
 * emits one row per line as "74576782 Approved". Stripping table pipes makes
 * the parser tolerant of other Tesseract builds.
 */
export function parseOcrDecisionText(text) {
  const decisions = new Map();
  const re = /(?:^|\n)\s*\|?\s*(\d{7,10})\s*\|?\s*(Approved|Refused)\b/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const number = match[1];
    const decision = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
    decisions.set(number, decision);
  }
  return [...decisions.entries()].map(([number, decision]) => ({ number, decision }));
}

export function parseReportPeriodEnd(text) {
  const value = String(text || '');
  const dates = [];
  for (const match of value.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  for (const match of value.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    dates.push(`${match[1]}-${match[2]}-${match[3]}`);
  }
  return dates.sort().at(-1) || null;
}
