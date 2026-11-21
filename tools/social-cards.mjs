#!/usr/bin/env node
/**
 * Office and month social cards.
 *
 * A generic og-image makes every office link look the same in WhatsApp,
 * Telegram and forums. These cards carry the office (or month), the latest
 * report date and the published counts, and are generated from the same
 * manifest/report helpers as the pages. PNG keeps the cards usable by social
 * crawlers that do not render SVG.
 *
 *   node tools/social-cards.mjs --write   # refresh checked-in cards
 *   node tools/social-cards.mjs           # build cards into .pages-dist
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from 'canvas';

import { buildMonthlyReport } from '../functions/report-data.js';
import { loadMonthlyData } from './monthly-pages.mjs';
import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WIDTH = 1200;
const HEIGHT = 630;

const num = (value) => Number(value || 0).toLocaleString('en-IE');
const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function longDate(iso) {
  const raw = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const [year, month, day] = raw.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

function monthLabel(month) {
  const [year, number] = String(month || '').split('-');
  return MONTHS[Number(number) - 1] ? `${MONTHS[Number(number) - 1]} ${year}` : month;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, height / 2, width / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function background(ctx) {
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, '#082f24');
  gradient.addColorStop(0.6, '#0b3b2e');
  gradient.addColorStop(1, '#115441');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#34d399';
  ctx.fillRect(0, 0, WIDTH, 10);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.arc(1060, 90, 220, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(1120, 560, 160, 0, Math.PI * 2);
  ctx.fill();
}

function footer(ctx) {
  ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.font = '500 20px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Independent and unofficial  ·  not immigration advice', 72, 566);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '600 20px "Segoe UI", Arial, sans-serif';
  ctx.fillText(SITE.replace(/^https?:\/\//, ''), WIDTH - 72, 566);
  ctx.textAlign = 'left';
}

function brand(ctx, kicker) {
  ctx.fillStyle = '#a7f3d0';
  ctx.font = '700 20px "Segoe UI", Arial, sans-serif';
  ctx.fillText(kicker.toUpperCase(), 72, 76);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 26px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Irish Visa Decision Tracker', 72, 112);
}

function pill(ctx, text, x, y) {
  ctx.font = '700 24px "Segoe UI", Arial, sans-serif';
  const width = ctx.measureText(text).width + 44;
  ctx.fillStyle = 'rgba(52, 211, 153, 0.18)';
  roundRect(ctx, x, y, width, 48, 24);
  ctx.fill();
  ctx.strokeStyle = 'rgba(110, 231, 183, 0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#d1fae5';
  ctx.fillText(text, x + 22, y + 32);
}

function fitFont(ctx, text, maxWidth, start, weight = '700', family = '"Segoe UI", Arial, sans-serif') {
  let size = start;
  do {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 4;
  } while (size > 32);
  return size;
}

function drawOfficeCard(office) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  background(ctx);
  brand(ctx, 'Latest official file');

  ctx.fillStyle = '#ffffff';
  const nameSize = fitFont(ctx, office.name, 980, 76);
  ctx.font = `700 ${nameSize}px "Segoe UI", Arial, sans-serif`;
  ctx.fillText(office.name, 72, 232);

  ctx.fillStyle = '#a7f3d0';
  ctx.font = '600 28px "Segoe UI", Arial, sans-serif';
  ctx.fillText(longDate(office.report_date), 72, 286);

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 108px "Segoe UI", Arial, sans-serif';
  ctx.fillText(num(office.decisions), 72, 414);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = '500 26px "Segoe UI", Arial, sans-serif';
  const countWidth = ctx.measureText(`${num(office.decisions)}`).width;
  ctx.fillText('decisions in the latest file', 72 + Math.max(360, countWidth + 24), 410);

  const rate = office.decisions ? pct((Number(office.approved) / Number(office.decisions)) * 100) : '—';
  pill(ctx, `${rate} approved`, 72, 452);
  ctx.fillStyle = 'rgba(255,255,255,0.76)';
  ctx.font = '500 24px "Segoe UI", Arial, sans-serif';
  ctx.fillText(`${num(office.approved)} approved  ·  ${num(office.refused)} refused`, 72, 536);

  footer(ctx);
  return canvas.toBuffer('image/png');
}

function drawMonthCard(report) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  background(ctx);
  brand(ctx, 'Monthly report');

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 70px "Segoe UI", Arial, sans-serif';
  ctx.fillText(monthLabel(report.month), 72, 232);

  ctx.fillStyle = '#a7f3d0';
  ctx.font = '600 28px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Dated decisions in the published files', 72, 282);

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 108px "Segoe UI", Arial, sans-serif';
  ctx.fillText(num(report.totals.total), 72, 414);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = '500 26px "Segoe UI", Arial, sans-serif';
  ctx.fillText('dated decisions this month', 72 + Math.max(320, ctx.measureText(num(report.totals.total)).width + 24), 410);

  pill(ctx, `${pct(report.totals.approval_rate)} approved`, 72, 452);
  ctx.fillStyle = 'rgba(255,255,255,0.76)';
  ctx.font = '500 24px "Segoe UI", Arial, sans-serif';
  ctx.fillText(`${num(report.totals.approved)} approved  ·  ${num(report.totals.refused)} refused`, 72, 536);

  footer(ctx);
  return canvas.toBuffer('image/png');
}

export async function buildSocialCards(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || ROOT);
  const outRoot = path.resolve(options.outDir || path.join(assetsRoot, 'assets', 'social'));
  const manifest = JSON.parse(fs.readFileSync(path.join(assetsRoot, 'data', 'data_manifest.json'), 'utf8'));
  const data = await loadMonthlyData(assetsRoot);
  const latestMonth = data.latestDate ? data.latestDate.slice(0, 7) : '';
  const months = [...new Set(data.rows
    .filter((row) => row.dated !== false && /^\d{4}-\d{2}/.test(row.date))
    .map((row) => row.date.slice(0, 7)))]
    .sort()
    .reverse();

  fs.mkdirSync(outRoot, { recursive: true });
  let count = 0;
  for (const office of manifest.offices || []) {
    if (!office || !office.slug || !Number(office.decisions)) continue;
    fs.writeFileSync(path.join(outRoot, `office-${office.slug}.png`), drawOfficeCard(office));
    count += 1;
  }
  for (const month of months) {
    const report = buildMonthlyReport(data.rows, month, data.officeList);
    fs.writeFileSync(path.join(outRoot, `month-${month}.png`), drawMonthCard(report));
    count += 1;
  }
  return { count, latestMonth, months: months.length, outRoot };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outDir = process.argv.includes('--write')
    ? path.join(ROOT, 'assets', 'social')
    : path.join(ROOT, '.pages-dist', 'assets', 'social');
  buildSocialCards({ outDir })
    .then((result) => console.log(`Social cards: ${result.count} PNG(s) in ${path.relative(ROOT, result.outRoot)}.`))
    .catch((error) => {
      console.error('Social cards failed:', error);
      process.exit(1);
    });
}
