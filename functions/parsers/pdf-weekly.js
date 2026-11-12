/**
 * PDF Weekly Parser
 * 
 * Handles embassies that publish weekly PDF reports (Abu Dhabi, Abuja, Ankara).
 * Each PDF covers one week of decisions.
 * Uses pdfjs for text-based PDFs, falls back to Tesseract.js OCR for scanned/image-based PDFs.
 */

import * as pdfjs from 'pdfjs-dist';
import * as cheerio from 'cheerio';
import { createWorker } from 'tesseract.js';
import { createCanvas } from 'canvas';

function extractWeekFromFilename(filename) {
  // Try to extract date from filename like "visa-decisions-2026-11-01.pdf"
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().slice(0, 10);
}

async function fetchPDF(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/pdf',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.ireland.ie/',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

function parseTextContent(textItems) {
  // pdfjs returns text items with x, y, str
  // Group by y coordinate (lines), then parse
  const lines = new Map();
  for (const item of textItems) {
    const y = Math.round(item.transform[5]);
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push(item.str);
  }
  return Array.from(lines.values()).map(arr => arr.join(' ')).filter(l => l.trim());
}

/**
 * OCR fallback for scanned/image-based PDFs
 * Renders each page as image and runs Tesseract OCR
 * Returns empty array if OCR fails (e.g., for vector-path PDFs like Ankara)
 */
async function parsePDFWithOCR(buffer, embassySlug, weekDate = null) {
  const loadingTask = pdfjs.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  const decisions = [];
  const seen = new Set();
  const week = weekDate || new Date().toISOString().slice(0, 10);

  // Create Tesseract worker (reuse for all pages)
  const worker = await createWorker('eng');
  
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      
      // Render page at 2x scale for better OCR accuracy
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');
      
      await page.render({ canvasContext: context, viewport: viewport }).promise;
      
      // Run OCR - tesseract.js can accept canvas from the canvas package
      // Wrap in try-catch to handle worker errors
      let text = '';
      try {
        const result = await worker.recognize(canvas);
        text = result.data.text || '';
      } catch (recognizeError) {
        console.warn(`[${embassySlug}] OCR recognize failed on page ${i}: ${recognizeError.message}`);
        continue;
      }
      
      // Parse OCR text for decisions
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      
      for (const line of lines) {
        // Look for patterns like: "12345678 Approved" or "12345678 Refused"
        // OCR might have errors, so be more flexible
        const match = line.match(/(\d{7,10})[\s\S]*?(Approved|Refused|Granted|Denied|Accepted|Issued|Rejected)/i);
        if (match) {
          const number = match[1];
          const decision = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();
          if (!seen.has(number)) {
            seen.add(number);
            decisions.push({
              number,
              decision,
              date: week,
              embassy: embassySlug
            });
          }
        }
      }
    }
  } catch (workerError) {
    console.warn(`[${embassySlug}] OCR worker failed: ${workerError.message}`);
  } finally {
    try {
      await worker.terminate();
    } catch (e) {
      // Ignore termination errors
    }
  }

  return decisions;
}

export async function parsePDFWeekly(pdfUrl, embassySlug, weekDate = null) {
  const buffer = await fetchPDF(pdfUrl);
  const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) }); // Clone buffer
  const pdf = await loadingTask.promise;

  const decisions = [];
  const seen = new Set();
  const week = weekDate || extractWeekFromFilename(pdfUrl);

  // First try: extract text with pdfjs
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const lines = parseTextContent(textContent.items);

    for (const line of lines) {
      // Look for patterns like: "12345678 Approved" or "12345678 Refused"
      const match = line.match(/(\d{7,10})\s+(Approved|Refused|Granted|Refused)/i);
      if (match) {
        const number = match[1];
        const decision = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();
        if (!seen.has(number)) {
          seen.add(number);
          decisions.push({
            number,
            decision,
            date: week,
            embassy: embassySlug
          });
        }
      }
    }
  }

  // If no decisions found, try OCR fallback (for scanned PDFs like Abu Dhabi, Abuja)
  // Skip OCR for Ankara as its PDF uses vector paths that OCR cannot read
  if (decisions.length === 0 && embassySlug !== 'ankara') {
    console.log(`[${embassySlug}] No text extracted, trying OCR...`);
    try {
      const ocrDecisions = await parsePDFWithOCR(buffer.slice(0), embassySlug, week); // Clone buffer
      console.log(`[${embassySlug}] OCR found ${ocrDecisions.length} decisions`);
      return ocrDecisions;
    } catch (ocrError) {
      console.warn(`[${embassySlug}] OCR failed: ${ocrError.message}`);
      return [];
    }
  } else if (decisions.length === 0 && embassySlug === 'ankara') {
    console.log(`[${embassySlug}] No text extracted; OCR skipped (vector-path PDF not supported)`);
    return [];
  }

  return decisions;
}

// Helper to discover latest PDF URL from embassy page
export async function discoverLatestPDF(baseUrl, embassySlug) {
  const response = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await response.text();
  const $ = cheerio.load(html);

  // Look for PDF links (don't filter by name since each embassy uses different naming)
  const pdfLinks = $('a[href$=".pdf"]').toArray()
    .map(a => $(a).attr('href'))
    .filter(h => h);

  if (pdfLinks.length === 0) return null;

  // Return the most recent (first) one
  return new URL(pdfLinks[0], baseUrl).href;
}