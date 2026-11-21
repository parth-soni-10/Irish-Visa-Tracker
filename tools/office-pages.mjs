#!/usr/bin/env node
/**
 * Office landing pages.
 *
 * Six substantive pages, one per published visa office. The page copy is
 * office-specific; this module owns the shared shell, schema, CTA and table
 * markup so the pages do not drift apart. Dynamic numbers are emitted as
 * `data-office="…"` spans and replaced at build time by deploy-pages.mjs from
 * data_manifest.json and visa_decisions.json.
 *
 *   node tools/office-pages.mjs --write
 *   node tools/office-pages.mjs --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://irishvisaupdatetracker.pages.dev';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const longDate = (iso) => {
  const [year, month, day] = String(iso).slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
};
const pct = (part, total) => `${total ? ((part / total) * 100).toFixed(1) : '0.0'}%`;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);

const OFFICES = [
  {
    slug: 'new-delhi',
    name: 'New Delhi',
    file: 'new-delhi-visa-decisions.html',
    route: '/new-delhi-visa-decisions',
    title: 'Ireland Visa Decision List – New Delhi | Check Your Status',
    description: 'Search the latest New Delhi Irish visa decision list by application number, with approved and refused counts, official processing times and data limits.',
    h1: 'Ireland visa decision list – New Delhi',
    kicker: 'New Delhi visa office',
    latestLabel: 'Latest official file',
    latestNote: 'Report date',
    fallback: {
      latest: '2026-11-19', checked: '2026-11-20',
      decisions: 43599, approved: 36769, refused: 6830,
      archive: '128 published days from 12 July 2026',
    },
    sourceUrl: 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
    sourceName: 'Embassy of Ireland, New Delhi — processing times and decisions',
    sourceFile: 'https://www.ireland.ie/5346/20261119_NDVO_Visa_Decisions.ods',
    sourceLabel: 'Open the latest New Delhi ODS',
    dataUrl: '/data/visa_decisions.json',
    aboutName: 'Embassy of Ireland, New Delhi',
    coverage: ['India', 'Bangladesh', 'Nepal', 'Sri Lanka'],
    lede: 'The Embassy of Ireland in New Delhi — the New Delhi Visa Office, or NDVO — publishes a cumulative list of Irish visa decisions each morning. This page tracks the latest file, the office’s published processing times and what the list can and cannot tell you about an application.',
    historyHtml: 'The tracker’s searchable history covers <strong data-office="history">128 published days</strong> from 12 July 2026.',
    extraTableRow: '<tr><th>Latest official-file day</th><td><span data-office="latest-day">19 November 2026: 183 decisions (143 approved, 40 refused)</span></td></tr>\n            <tr><th>Tracker’s latest day</th><td><span data-office="tracker-latest">20 November 2026: 65 decisions (58 approved, 7 refused; partial day, not in the latest official file)</span></td></tr>',
    whatHtml: `
      <p>Each morning, by about 11:00 Indian Standard Time, the Embassy publishes a cumulative spreadsheet of visa decisions made in 2026 up to the previous day. Each row is an application number and one outcome: <strong>Approved</strong> or <strong>Refused</strong>.</p>
      <p>The list is cumulative, not a daily-only file. The tracker keeps the dated history, so you can search one application number or see how many decisions were published on a given day.</p>
      <p>New Delhi does not provide individual status updates. The published list is the status record; the embassy asks applicants not to contact it for updates.</p>`,
    scopeHtml: `
      <p>New Delhi accepts visa applications from <strong>India, Bangladesh, Nepal and Sri Lanka</strong>.</p>
      <p>A VFS centre is not the visa office. Your receipt or acknowledgement shows which office has your file.</p>
      <p>Some applications are transferred to Dublin for processing: EU Free Movement family applications; Join Family applications for an Irish national de facto partner, a CSEP/HA de facto partner or a UK national; Minister of Religion; and Volunteer. Those decisions appear in Dublin’s list, not New Delhi’s.</p>
      <p>If your number is missing here, search <a href="/?tracker=visa&amp;tab=search">all six offices</a> before concluding anything.</p>`,
    scheduleTitle: 'New Delhi processing times',
    scheduleHtml: `
      <div class="table-wrap" role="region" aria-label="New Delhi processing times" tabindex="0">
        <table class="office-table">
          <caption>Official usual timeframes published by the embassy</caption>
          <thead><tr><th>Visa category</th><th>First-instance decision</th><th>Appeal decision</th></tr></thead>
          <tbody>
            <tr><th>Employment — Category A</th><td>4–6 weeks</td><td>6 calendar months</td></tr>
            <tr><th>Employment — Category B</th><td>8–10 weeks</td><td>6 calendar months</td></tr>
            <tr><th>Join Family</th><td>6–12 months</td><td>12 calendar months</td></tr>
            <tr><th>Study</th><td>4–8 weeks</td><td>6 calendar months</td></tr>
            <tr><th>Business / Conference / Event</th><td>4 weeks</td><td>N/A</td></tr>
            <tr><th>Visit</th><td>6–8 weeks</td><td>N/A</td></tr>
          </tbody>
        </table>
      </div>
      <p class="small-note">Official usual timeframes published on 17 September 2026. They are <strong>not guarantees</strong>. They count working days from receipt at the embassy and exclude VFS appointment waits, document transit and return delivery. The embassy advises applying up to 90 days before travel.</p>
      <p class="small-note">From 1 June 2026, short-stay refusal appeals are no longer available except for EU Free Movement cases. Read your decision letter for the route that applies.</p>`,
    missingExtra: '<li><strong>Another office may have the file.</strong> Some categories are decided in Dublin; search all six offices rather than assuming New Delhi refused or lost the application.</li>',
    dataNoteHtml: '<p>Latest official file: <span data-office="latest-date">19 November 2026</span>. Tracker checked: <span data-office="checked-date">20 November 2026</span>. History: <span data-office="archive">128 published days from 12 July 2026</span>. The tracker keeps the New Delhi history as <code>[date, application number, decision]</code> rows. The latest official cumulative file is the authority for the counts above; the history adds the dated days the embassy has published.</p>',
    faq: (f) => [
      ['How often does New Delhi publish visa decisions?', 'Each morning, by about 11:00 Indian Standard Time, the embassy publishes a cumulative list of decisions made in 2026 up to the previous day.'],
      ['Where do I find my New Delhi application number?', 'Use the 8-digit application number on your receipt, acknowledgement email or decision email. An IRL prefix, spaces and dashes are optional. Do not use a VFS reference, passport number or courier tracking number.'],
      ['Which countries does the New Delhi visa office handle?', 'India, Bangladesh, Nepal and Sri Lanka. Some categories are processed in Dublin instead, so search all six offices if your number is missing.'],
      ['Why is my application number not in the New Delhi list?', 'It may not be decided or published yet, your file may be with Dublin, the number may be in a different format, or the latest file may not have loaded. A missing number is not a refusal.'],
      ['How long does a New Delhi visa take?', 'The embassy’s published usual timeframes are 4–6 weeks for Employment Category A, 8–10 weeks for Category B, 4–8 weeks for Study, 4 weeks for Business/Conference/Event, 6–8 weeks for Visit and 6–12 months for Join Family. They are not guarantees and exclude VFS transit.'],
      ['Does an Approved result mean my passport is ready?', 'No. The list records the decision, not the passport’s location. Wait for the official decision letter and the VFS return process.'],
      ['How many decisions are in the latest New Delhi file?', `The file dated ${longDate(f.latest)} contains ${f.decisions.toLocaleString('en-IE')} decisions: ${f.approved.toLocaleString('en-IE')} approved and ${f.refused.toLocaleString('en-IE')} refused.`],
    ],
  },
  {
    slug: 'beijing',
    name: 'Beijing',
    file: 'beijing-visa-decisions.html',
    route: '/beijing-visa-decisions',
    title: 'Ireland Visa Decision List – Beijing | Check Your Status',
    description: 'Search the latest Beijing Irish visa decision list by application number, with approved and refused counts, office scope and snapshot limits.',
    h1: 'Ireland visa decision list – Beijing',
    kicker: 'Beijing visa office',
    latestLabel: 'Latest snapshot',
    latestNote: 'Snapshot date',
    fallback: {
      latest: '2026-11-01', checked: '2026-11-20',
      decisions: 13724, approved: 11373, refused: 2351,
      archive: '1 snapshot · 13,724 decisions',
    },
    sourceUrl: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
    sourceName: 'Embassy of Ireland, Beijing — visa decisions',
    sourceFile: 'https://www.ireland.ie/5288/20261101_BVO_visa_decisions.ods',
    sourceLabel: 'Open the latest Beijing ODS',
    dataUrl: '/data/embassy-beijing.json',
    aboutName: 'Embassy of Ireland, Beijing',
    coverage: ['China', 'Hong Kong', 'Macau', 'Mongolia'],
    lede: 'The Embassy of Ireland in Beijing publishes a cumulative decision file for the applications it handles. This page tracks the latest snapshot, the office’s scope and what the published file does and does not show.',
    historyHtml: 'The tracker holds <strong data-office="history">the latest snapshot</strong>, not a full dated history.',
    whatHtml: `
      <p>Beijing publishes a cumulative decision file for its visa office. The tracker records the latest published snapshot rather than a dated daily archive.</p>
      <p>The last check on <span data-office="checked-date">20 November 2026</span> found no newer decision-file link than the <span data-office="latest-date">1 November 2026</span> snapshot. That does not mean no decisions have been made since; it means the tracker has not found a newer published file.</p>
      <p>Check the official Beijing page for a newer file, and use the search above to check the snapshot the tracker holds.</p>`,
    scopeHtml: `
      <p>Beijing accepts visa applications from <strong>China, Hong Kong, Macau and Mongolia</strong>.</p>
      <p>A VFS centre is not the visa office. Your receipt or acknowledgement shows which office has your file.</p>
      <p>If your number is missing here, search <a href="/?tracker=visa&amp;tab=search">all six offices</a> before concluding anything.</p>`,
    scheduleTitle: 'How to read the Beijing snapshot',
    scheduleHtml: `
      <p>Beijing’s file is a snapshot, not a daily list. The tracker does not hold a separate dated history for Beijing, so the counts on this page describe the latest snapshot only.</p>
      <p>The snapshot date is the date of the published file, not the date of an individual decision. A recent decision may not appear until the office publishes a newer file.</p>
      <p>If the official page shows a file newer than the one linked here, the official file is the authority.</p>`,
    missingExtra: '<li><strong>The snapshot may not have been refreshed.</strong> The tracker’s last check found no newer decision-file link than the snapshot shown above.</li>',
    dataNoteHtml: '<p>The tracker stores the latest Beijing snapshot. It is searchable by application number, but it is not a complete dated archive.</p>',
    faq: () => [
      ['How often does Beijing publish visa decisions?', 'The office publishes a cumulative decision file on its official page. The tracker keeps the latest snapshot; its last check found no newer file link than the snapshot shown on this page.'],
      ['Which countries does the Beijing visa office handle?', 'China, Hong Kong, Macau and Mongolia.'],
      ['Why is my application number not in the Beijing list?', 'The decision may not be published yet, the snapshot may not include it, your file may be with another office, or the number may be in a different format. A missing number is not a refusal.'],
      ['Is the Beijing data live?', 'No. It is the latest published snapshot the tracker has found, not a live feed or a daily archive.'],
      ['Does an Approved result mean my passport is ready?', 'No. The list records the decision, not the passport’s location. Wait for the official decision letter and the VFS return process.'],
    ],
  },
  {
    slug: 'abu-dhabi',
    name: 'Abu Dhabi',
    file: 'abu-dhabi-visa-decisions.html',
    route: '/abu-dhabi-visa-decisions',
    title: 'Ireland Visa Decision List – Abu Dhabi | Check Your Status',
    description: 'Search the latest Abu Dhabi Irish visa decision list by application number, with weekly approved and refused counts, country scope and report dates.',
    h1: 'Ireland visa decision list – Abu Dhabi',
    kicker: 'Abu Dhabi visa office',
    latestLabel: 'Latest weekly report',
    latestNote: 'Week ending',
    fallback: {
      latest: '2026-11-20', checked: '2026-11-20',
      decisions: 232, approved: 161, refused: 71,
      archive: '11 weekly reports · 2,900 decisions',
    },
    sourceUrl: 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
    sourceName: 'Embassy of Ireland, Abu Dhabi — weekly decision reports',
    sourceFile: 'https://www.ireland.ie/5347/Decisions_for_period_from_15-11-2026_to_20-11-2026.pdf',
    sourceLabel: 'Open the latest Abu Dhabi PDF',
    dataUrl: '/data/embassy-abu-dhabi.json',
    aboutName: 'Embassy of Ireland, Abu Dhabi',
    coverage: ['United Arab Emirates', 'Afghanistan', 'Algeria', 'Bahrain', 'Jordan', 'Kuwait', 'Lebanon', 'Libya', 'Morocco', 'Oman', 'Qatar', 'Sudan', 'Syria', 'Tunisia'],
    lede: 'The Embassy of Ireland in Abu Dhabi publishes visa decisions in weekly PDF reports. This page tracks the latest report, the office’s country scope and how to read a weekly decision period.',
    historyHtml: 'The tracker’s archive holds <strong data-office="history">11 weekly reports</strong>.',
    whatHtml: `
      <p>Abu Dhabi publishes a weekly PDF decision report. Each report covers a period and lists the applications decided in that period, with an approved or refused outcome.</p>
      <p>The report date is the end of the period, not the date of an individual decision. A number may appear in one weekly report and not another, so search the office history rather than only the latest file.</p>
      <p>The tracker keeps each dated report it has ingested, which is what makes the weekly history searchable.</p>`,
    scopeHtml: `
      <p>Abu Dhabi accepts visa applications from the <strong>United Arab Emirates, Afghanistan, Algeria, Bahrain, Jordan, Kuwait, Lebanon, Libya, Morocco, Oman, Qatar, Sudan, Syria and Tunisia</strong>.</p>
      <p>A VFS centre is not the visa office. Your receipt or acknowledgement shows which office has your file.</p>
      <p>If your number is missing here, search <a href="/?tracker=visa&amp;tab=search">all six offices</a> before concluding anything.</p>`,
    scheduleTitle: 'How the weekly reports work',
    scheduleHtml: `
      <p>Each report covers a reporting period and ends on the report date shown above. The applications in that report may have been decided at different points inside the period.</p>
      <p>The archive currently holds 11 weekly reports. A missing number may be in an earlier or later report, so use the office history and check the official page for the newest file.</p>
      <p>Weekly reports are snapshots of their period, not a live queue. They do not show when an individual passport will be returned.</p>`,
    missingExtra: '<li><strong>Try the weekly archive.</strong> A number may be in an earlier or later weekly report rather than the latest one.</li>',
    dataNoteHtml: '<p>The tracker stores each dated Abu Dhabi weekly report. The archive count covers the reports it has ingested, not every report the embassy has ever published.</p>',
    faq: () => [
      ['How often does Abu Dhabi publish visa decisions?', 'The office publishes weekly PDF decision reports. Each report covers a period and carries the period-end date.'],
      ['Which countries does the Abu Dhabi visa office handle?', 'The United Arab Emirates, Afghanistan, Algeria, Bahrain, Jordan, Kuwait, Lebanon, Libya, Morocco, Oman, Qatar, Sudan, Syria and Tunisia.'],
      ['Why is my number missing from the latest Abu Dhabi report?', 'It may be in an earlier or later weekly report, the decision may not be published yet, or your file may be with another office. Search the archive before treating it as a refusal.'],
      ['What does the report date mean?', 'It is the end of the reporting period, not the date of an individual decision.'],
      ['Does an Approved result mean my passport is ready?', 'No. The report records the decision, not the passport’s location. Wait for the official decision letter and the VFS return process.'],
    ],
  },
  {
    slug: 'abuja',
    name: 'Abuja',
    file: 'abuja-visa-decisions.html',
    route: '/abuja-visa-decisions',
    title: 'Ireland Visa Decision List – Abuja | Check Your Status',
    description: 'Search the latest Abuja Irish visa decision list by application number, with weekly approved and refused counts, country scope and report dates.',
    h1: 'Ireland visa decision list – Abuja',
    kicker: 'Abuja visa office',
    latestLabel: 'Latest weekly report',
    latestNote: 'Week ending',
    fallback: {
      latest: '2026-11-07', checked: '2026-11-20',
      decisions: 99, approved: 34, refused: 65,
      archive: '28 weekly reports · 2,375 decisions',
    },
    sourceUrl: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
    sourceName: 'Embassy of Ireland, Abuja — weekly decision reports',
    sourceFile: 'https://www.ireland.ie/5331/decision_01_to_07_novem.pdf',
    sourceLabel: 'Open the latest Abuja PDF',
    dataUrl: '/data/embassy-abuja.json',
    aboutName: 'Embassy of Ireland, Abuja',
    coverage: ['Nigeria', 'Côte d’Ivoire', 'Ghana', 'Senegal'],
    lede: 'The Embassy of Ireland in Abuja publishes visa decisions in weekly PDF reports. This page tracks the latest report, the office’s country scope and how to read a weekly decision period.',
    historyHtml: 'The tracker’s archive holds <strong data-office="history">28 weekly reports</strong>.',
    whatHtml: `
      <p>Abuja publishes a weekly PDF decision report. Each report covers a period and lists the applications decided in that period, with an approved or refused outcome.</p>
      <p>The report date is the end of the period, not the date of an individual decision. A number may appear in one weekly report and not another, so search the office history rather than only the latest file.</p>
      <p>The tracker keeps each dated report it has ingested, including older reports that the office no longer highlights.</p>`,
    scopeHtml: `
      <p>Abuja accepts visa applications from <strong>Nigeria, Côte d’Ivoire, Ghana and Senegal</strong>.</p>
      <p>A VFS centre is not the visa office. Your receipt or acknowledgement shows which office has your file.</p>
      <p>If your number is missing here, search <a href="/?tracker=visa&amp;tab=search">all six offices</a> before concluding anything.</p>`,
    scheduleTitle: 'How the weekly reports work',
    scheduleHtml: `
      <p>Each report covers a reporting period and ends on the report date shown above. The applications in that report may have been decided at different points inside the period.</p>
      <p>The archive currently holds 28 weekly reports. A missing number may be in an earlier or later report, so use the office history and check the official page for the newest file.</p>
      <p>Weekly reports are snapshots of their period, not a live queue. They do not show when an individual passport will be returned.</p>`,
    missingExtra: '<li><strong>Try the weekly archive.</strong> A number may be in an earlier or later weekly report rather than the latest one.</li>',
    dataNoteHtml: '<p>The tracker stores each dated Abuja weekly report. The archive count covers the reports it has ingested, not every report the embassy has ever published.</p>',
    faq: () => [
      ['How often does Abuja publish visa decisions?', 'The office publishes weekly PDF decision reports. Each report covers a period and carries the period-end date.'],
      ['Which countries does the Abuja visa office handle?', 'Nigeria, Côte d’Ivoire, Ghana and Senegal.'],
      ['Why is my number missing from the latest Abuja report?', 'It may be in an earlier or later weekly report, the decision may not be published yet, or your file may be with another office. Search the archive before treating it as a refusal.'],
      ['What does the report date mean?', 'It is the end of the reporting period, not the date of an individual decision.'],
      ['Does an Approved result mean my passport is ready?', 'No. The report records the decision, not the passport’s location. Wait for the official decision letter and the VFS return process.'],
    ],
  },
  {
    slug: 'ankara',
    name: 'Ankara',
    file: 'ankara-visa-decisions.html',
    route: '/ankara-visa-decisions',
    title: 'Ireland Visa Decision List – Ankara | Check Your Status',
    description: 'Search the latest Ankara Irish visa decision list by application number, with weekly approved and refused counts, country scope and OCR notes.',
    h1: 'Ireland visa decision list – Ankara',
    kicker: 'Ankara visa office',
    latestLabel: 'Latest weekly report',
    latestNote: 'Week ending',
    fallback: {
      latest: '2026-11-15', checked: '2026-11-20',
      decisions: 165, approved: 128, refused: 37,
      archive: '5 weekly reports · 792 decisions',
    },
    sourceUrl: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/',
    sourceName: 'Embassy of Ireland, Ankara — weekly decision report',
    sourceFile: 'https://www.ireland.ie/5319/Ankara_Visa_Decisions_07_November_2026_to_15_November_2026.pdf',
    sourceLabel: 'Open the latest Ankara PDF',
    dataUrl: '/data/embassy-ankara.json',
    aboutName: 'Embassy of Ireland, Ankara',
    coverage: ['Türkiye', 'Azerbaijan', 'Visa-required nationals resident in Saudi Arabia'],
    lede: 'The Embassy of Ireland in Ankara publishes visa decisions in weekly PDF reports, including scanned reports. This page tracks the latest report, the office’s scope and the OCR caveat that applies to its data.',
    historyHtml: 'The tracker’s archive holds <strong data-office="history">5 weekly reports</strong>.',
    whatHtml: `
      <p>Ankara publishes a weekly PDF decision report. Each report covers a period and lists the applications decided in that period, with an approved or refused outcome.</p>
      <p>Some Ankara reports are image-based PDFs. The tracker extracts their text with OCR at 300 DPI and stores the result as a searchable report, so a name or number can be misread at the source.</p>
      <p>The official PDF is always the authority. If a row looks wrong, check the source file before relying on it.</p>`,
    scopeHtml: `
      <p>Ankara accepts visa applications from <strong>Türkiye, Azerbaijan and visa-required nationals resident in Saudi Arabia</strong>.</p>
      <p>A VFS centre is not the visa office. Your receipt or acknowledgement shows which office has your file.</p>
      <p>If your number is missing here, search <a href="/?tracker=visa&amp;tab=search">all six offices</a> before concluding anything.</p>`,
    scheduleTitle: 'How the weekly reports and OCR work',
    scheduleHtml: `
      <p>Each report covers a reporting period and ends on the report date shown above. The applications in that report may have been decided at different points inside the period.</p>
      <p>Ankara reports can be scanned documents. The tracker uses poppler and Tesseract OCR at 300 DPI to make them searchable. OCR can miss or misread a character, so the extracted row is a finding aid, not a certified copy.</p>
      <p>The archive currently holds 5 weekly reports. A missing number may be in an earlier or later report, so use the office history and check the official page for the newest file.</p>`,
    missingExtra: '<li><strong>OCR may have missed the row.</strong> Check the official PDF for the report period before treating a missing number as unpublished.</li>',
    dataNoteHtml: '<p>The tracker stores each dated Ankara weekly report. OCR-extracted rows are compared with the report date and office, but the official PDF remains the authority.</p>',
    faq: () => [
      ['How often does Ankara publish visa decisions?', 'The office publishes weekly PDF decision reports. Each report covers a period and carries the period-end date.'],
      ['Which countries does the Ankara visa office handle?', 'Türkiye, Azerbaijan and visa-required nationals resident in Saudi Arabia.'],
      ['Why is my number missing from the Ankara list?', 'It may be in an earlier or later report, the decision may not be published yet, OCR may have missed the row, or your file may be with another office. Check the official PDF before treating it as a refusal.'],
      ['Why does Ankara data have an OCR note?', 'Some reports are scanned images. The tracker extracts their text with OCR to make them searchable; the official PDF is the authority.'],
      ['Does an Approved result mean my passport is ready?', 'No. The report records the decision, not the passport’s location. Wait for the official decision letter and the VFS return process.'],
    ],
  },
  {
    slug: 'dublin',
    name: 'Dublin',
    file: 'dublin-visa-decisions.html',
    route: '/dublin-visa-decisions',
    title: 'Ireland Visa Decision List – Dublin | Check Your Status',
    description: 'Search the latest Dublin Irish visa decision list by application number, with Tuesday updates, approved and refused counts and transferred-application scope.',
    h1: 'Ireland visa decision list – Dublin',
    kicker: 'Dublin visa office',
    latestLabel: 'Latest snapshot',
    latestNote: 'Report date',
    fallback: {
      latest: '2026-11-20', checked: '2026-11-20',
      decisions: 4475, approved: 2624, refused: 1851,
      archive: '1 snapshot · 4,475 decisions',
    },
    sourceUrl: 'https://www.irishimmigration.ie/visa-decisions/',
    sourceName: 'Immigration Service Delivery — visa decisions',
    sourceFile: 'https://www.irishimmigration.ie/visa-decisions/',
    sourceLabel: 'Open the official Dublin decisions page',
    dataUrl: '/data/embassy-dublin.json',
    aboutName: 'Immigration Service Delivery, Dublin Visa Office',
    coverage: ['Ireland'],
    lede: 'The Dublin Visa Office publishes decisions every Tuesday and a queue of processing dates by category. This page tracks the latest decision snapshot, the applications Dublin handles and how the Tuesday publication works.',
    historyHtml: 'The tracker holds <strong data-office="history">the latest snapshot</strong>; the Dublin Visa Office publishes decisions every Tuesday.',
    whatHtml: `
      <p>Dublin publishes a decision list every Tuesday and a separate queue of processing dates by visa category. The decision list is a snapshot of the latest published table, not a full dated archive on this site.</p>
      <p>The Dublin queue is not a decision list. It shows the application date the office has reached in each category; it does not say whether an individual application has been decided.</p>
      <p>Dublin also decides applications transferred from overseas offices, so a number that is missing from an embassy list may still appear here.</p>`,
    scopeHtml: `
      <p>Dublin handles applications transferred from overseas offices and certain categories, including EU Free Movement family applications; Join Family applications for an Irish national de facto partner, a CSEP/HA de facto partner or a UK national; Minister of Religion; and Volunteer.</p>
      <p>Dublin also publishes the queue for visa categories processed by the Dublin Visa Office. The queue is shown on <a href="/visa-processing-times">processing times</a>, not as an individual decision.</p>
      <p>A VFS centre is not the visa office. Your receipt or acknowledgement shows which office has your file.</p>`,
    scheduleTitle: 'Tuesday decisions and the Dublin queue',
    scheduleHtml: `
      <p>Dublin publishes visa decisions every Tuesday. A decision made after the latest snapshot may not appear until the next Tuesday publication.</p>
      <p>The Dublin queue covers 13 visa categories. It shows the processing date reached, not a decision for a particular application. Use <a href="/visa-processing-times">processing times</a> for the queue and this page for the published decision list.</p>
      <p>If your number is missing from the latest snapshot, check the official Dublin page on the next Tuesday before treating it as unpublished.</p>`,
    missingExtra: '<li><strong>Dublin publishes on Tuesdays.</strong> A decision made after the latest snapshot may appear in next week’s publication.</li>',
    dataNoteHtml: '<p>The tracker stores the latest Dublin decision snapshot and the Dublin queue separately. It does not hold a dated Dublin decision history.</p>',
    faq: () => [
      ['How often does Dublin publish visa decisions?', 'The Dublin Visa Office publishes visa decisions every Tuesday.'],
      ['Which applications does the Dublin visa office handle?', 'Dublin handles applications transferred from overseas offices and certain categories, including EU Free Movement family applications, specified Join Family categories, Minister of Religion and Volunteer. Check your receipt and the official ISD page for your file.'],
      ['Why is my number missing from the Dublin list?', 'The decision may not be published until the next Tuesday, your file may be with another office, or the number may be in a different format. A missing number is not a refusal.'],
      ['What is the Dublin queue?', 'It is a set of processing dates by visa category, not an individual decision list. See the processing times page for the current queue.'],
      ['Does an Approved result mean my passport is ready?', 'No. The list records the decision, not the passport’s location. Wait for the official decision letter and the VFS return process.'],
    ],
  },
];

function schemaFor(office) {
  const f = office.fallback;
  const faq = office.faq(f).map(([question, answer]) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: { '@type': 'Answer', text: answer },
  }));
  const graph = [
    {
      '@type': 'WebPage',
      '@id': `${SITE}${office.route}#webpage`,
      url: `${SITE}${office.route}`,
      name: office.h1,
      description: office.description,
      inLanguage: 'en',
      isPartOf: { '@id': `${SITE}/#website` },
      about: { '@type': 'GovernmentOffice', name: office.aboutName },
      dateModified: f.checked,
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${SITE}${office.route}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Tracker', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: `${office.name} visa decisions`, item: `${SITE}${office.route}` },
      ],
    },
    {
      '@type': 'Dataset',
      '@id': `${SITE}${office.route}#dataset`,
      name: `Irish Visa Decision Tracker — ${office.name} visa decisions`,
      description: `Published ${office.name} visa decisions, searchable by application number and updated from the office’s official reports.`,
      url: `${SITE}${office.dataUrl}`,
      encodingFormat: 'application/json',
      isAccessibleForFree: true,
      dateModified: f.checked,
      spatialCoverage: office.coverage,
      variableMeasured: ['Approved', 'Refused'],
      creator: { '@id': `${SITE}/#organization` },
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}${office.route}#faq`,
      mainEntity: faq,
    },
  ];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
}

function stats(office) {
  const f = office.fallback;
  return `<div class="status-grid">
        <div class="status-card"><span class="status-kicker" data-office="latest-label">${office.latestLabel}</span><strong data-office="latest-date">${longDate(f.latest)}</strong><span data-office="latest-note">${office.latestNote}</span></div>
        <div class="status-card"><span class="status-kicker">Decisions</span><strong data-office="decisions">${f.decisions.toLocaleString('en-IE')}</strong><span>In the latest file</span></div>
        <div class="status-card"><span class="status-kicker">Approved</span><strong data-office="approved">${f.approved.toLocaleString('en-IE')}</strong><span><span data-office="approval-share">${pct(f.approved, f.decisions)}</span> of decisions</span></div>
        <div class="status-card"><span class="status-kicker">Refused</span><strong data-office="refused">${f.refused.toLocaleString('en-IE')}</strong><span><span data-office="refused-share">${pct(f.refused, f.decisions)}</span> of decisions</span></div>
      </div>`;
}

function latestTable(office) {
  const f = office.fallback;
  return `<div class="table-wrap" role="region" aria-label="Latest ${office.name} official file" tabindex="0">
        <table class="office-table">
          <caption>Latest ${office.name} file</caption>
          <thead><tr><th>Measure</th><th>Value</th></tr></thead>
          <tbody>
            <tr><th>Report date</th><td data-office="latest-date">${longDate(f.latest)}</td></tr>
            <tr><th>Decisions</th><td data-office="decisions">${f.decisions.toLocaleString('en-IE')}</td></tr>
            <tr><th>Approved</th><td><span data-office="approved">${f.approved.toLocaleString('en-IE')}</span> (<span data-office="approval-share">${pct(f.approved, f.decisions)}</span>)</td></tr>
            <tr><th>Refused</th><td><span data-office="refused">${f.refused.toLocaleString('en-IE')}</span> (<span data-office="refused-share">${pct(f.refused, f.decisions)}</span>)</td></tr>
            ${office.extraTableRow || ''}
            <tr><th>Searchable history</th><td data-office="archive">${f.archive}</td></tr>
            <tr><th>Source file</th><td><a data-office="source-file" href="${office.sourceFile}" target="_blank" rel="noopener noreferrer"><span data-office="source-label">${office.sourceLabel}</span></a></td></tr>
          </tbody>
        </table>
      </div>`;
}

function reportHistory(office) {
  const f = office.fallback;
  return `<section id="report-history">
      <h2>Recent report history</h2>
      <p>${office.historyNote}</p>
      <div class="table-wrap" role="region" aria-label="Recent ${office.name} report history" tabindex="0">
        <table class="office-table">
          <caption>Recent reports in the tracker’s public archive, newest first. At most 8 rows are shown; consecutive unchanged snapshots are collapsed into one row.</caption>
          <thead><tr><th scope="col">Report date</th><th scope="col">Decisions</th><th scope="col">Approved</th><th scope="col">Refused</th><th scope="col">Approval rate</th><th scope="col">Official source</th></tr></thead>
          <tbody data-report-history="${office.slug}">
            <tr><td><time datetime="${f.latest}">${longDate(f.latest)}</time></td><td>${f.decisions.toLocaleString('en-IE')}</td><td>${f.approved.toLocaleString('en-IE')}</td><td>${f.refused.toLocaleString('en-IE')}</td><td>${pct(f.approved, f.decisions)}</td><td><a href="${esc(office.sourceFile)}" target="_blank" rel="noopener noreferrer">Official source</a></td></tr>
          </tbody>
        </table>
      </div>
      <p class="small-note">Approval rate is approved decisions divided by the decisions in that report. The latest official file table above remains the authority for the current counts. <a href="/reports/${office.slug}">Open the full ${office.name} report archive</a> for every dated report with its checksum and official file.</p>
    </section>`;
}

function faqSection(office) {
  const faq = office.faq(office.fallback);
  return `<section>
      <h2>Frequently asked questions</h2>
      <div class="faq">
        ${faq.map(([question, answer]) => `<h3>${question}</h3>\n        <p>${answer}</p>`).join('\n        ')}
      </div>
    </section>`;
}

function related(office) {
  const links = OFFICES.filter((item) => item.slug !== office.slug)
    .map((item) => `<a href="${item.route}">${item.name}</a>`)
    .join(' · ');
  return `<p class="page-nav">${links} · <a href="/visa-processing-times">Processing times</a> · <a href="/daily-summaries">Daily summaries</a> · <a href="/help">Help</a></p>`;
}

function render(office) {
  const f = office.fallback;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(office.title)}</title>
  <meta name="description" content="${esc(office.description)}">
  <link rel="canonical" href="${SITE}${office.route}">
  <link rel="manifest" href="/manifest.json">
  <link rel="describedby" href="/llms.txt" type="text/plain">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(office.title)}">
  <meta property="og:description" content="${esc(office.description)}">
  <meta property="og:url" content="${SITE}${office.route}">
  <meta property="og:image" content="${SITE}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(office.title)}">
  <meta name="twitter:description" content="${esc(office.description)}">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/pages.css">
  <link rel="stylesheet" href="/site-chrome.css">
  <script type="application/ld+json">
${schemaFor(office)}
  </script>
</head>
<body>
  <!-- site-chrome:start -->
  <!-- site-chrome:end -->
  <main id="main-content" tabindex="-1" class="page">
    <p class="page-kicker">${office.kicker}</p>
    <h1>${office.h1}</h1>
    <p class="page-meta">Independent and unofficial &bull; <span data-office="latest-label">${office.latestLabel}</span> <span data-office="latest-date">${longDate(f.latest)}</span> &bull; Checked <span data-office="checked-date">${longDate(f.checked)}</span> &bull; Not immigration advice</p>

    <p class="page-lede">${office.lede}</p>

    ${stats(office)}
    <p class="small-note">${office.historyHtml}</p>

    <p class="callout"><strong>Check your application number.</strong> Search the ${office.name} list with the 8-digit number from your receipt. An IRL prefix, spaces and dashes are optional.</p>
    <p class="office-actions">
      <a class="btn primary" href="/?tracker=visa&amp;tab=search&amp;office=${office.slug}">Search ${office.name} decisions</a>
      <a class="btn" href="${office.sourceUrl}" target="_blank" rel="noopener noreferrer">Official ${office.name} page</a>
    </p>

    <section>
      <h2>What ${office.name} publishes</h2>
      ${office.whatHtml}
    </section>

    <section>
      <h2>Latest official file</h2>
      ${latestTable(office)}
      <p class="small-note">Source: <a href="${office.sourceUrl}" target="_blank" rel="noopener noreferrer">${office.sourceName}</a>. The table links the latest ingested source file.</p>
      <p class="small-note">The tracker checked the source on <span data-office="checked-date">${longDate(f.checked)}</span>. The approval share describes the published rows, not the chance that a particular application will be approved.</p>
    </section>

    ${reportHistory(office)}

    <section>
      <h2>Which applications are handled by ${office.name}</h2>
      ${office.scopeHtml}
    </section>

    <section>
      <h2>${office.scheduleTitle}</h2>
      ${office.scheduleHtml}
    </section>

    <section>
      <h2>Why your number may be missing</h2>
      <ul>
        <li><strong>The decision has not been made or published yet.</strong> The office publishes on its own schedule; a recent decision may not appear in the latest file.</li>
        <li><strong>Your file may be with another office.</strong> A VFS centre is not necessarily the visa office that decided the case.</li>
        <li><strong>The number may be in a different format.</strong> Use the 8-digit application number; an IRL prefix, spaces and dashes are optional.</li>
        <li><strong>You may be using a different reference.</strong> A VFS reference, passport number, payment reference or courier tracking number will not match a published decision.</li>
        <li><strong>The latest file may not have loaded.</strong> Check <a href="/status">Data status</a> for the last successful check. Do not read a missing file as a refusal.</li>
        ${office.missingExtra}
      </ul>
      <p class="small-note">A missing number is <strong>not a refusal</strong>. It means the tracker could not find it in the reports it checked.</p>
    </section>

    <section>
      <h2>What Approved and Refused mean</h2>
      <p><strong>Approved</strong> means the published report records an approval. It is not the visa itself, and it does not tell you when your passport will be returned.</p>
      <p><strong>Refused</strong> means the published report records a refusal. The report does not give the reason. Read your decision letter for the reason and any review or appeal deadline.</p>
      <p>Always confirm the outcome on the official source and in your own decision letter. The tracker cannot change or appeal a decision.</p>
    </section>

    <section>
      <h2>How to search and get alerts</h2>
      <ol>
        <li>Open <a href="/?tracker=visa&amp;tab=search&amp;office=${office.slug}">Search</a> with ${office.name} already selected.</li>
        <li>Enter the 8-digit application number.</li>
        <li>Confirm the result against the official ${office.name} file.</li>
      </ol>
      <p><strong>Free Telegram alert:</strong> add the number in the <a href="/?tracker=visa&amp;tab=alerts">Alerts tab</a> and open the Telegram bot link. The bot sends one message when the number appears in a later published report. No account and no fee.</p>
    </section>

    <section>
      <h2>Data notes and corrections</h2>
      <p>Source: <a href="${office.sourceUrl}" target="_blank" rel="noopener noreferrer">${office.sourceName}</a>. Public data: <a href="${office.dataUrl}">${office.dataUrl}</a>.</p>
      ${office.dataNoteHtml}
      <p class="small-note">This is an independent, unofficial tracker. It is not affiliated with the Embassy of Ireland, ISD or any Irish government body, and it is not immigration advice. If a row is wrong or missing, report it with the office, report date and source URL through the <a href="/corrections">correction ledger</a>.</p>
    </section>

    ${faqSection(office)}

    ${related(office)}
  </main>
  <!-- site-footer:start -->
  <!-- site-footer:end -->
  <script src="/site-chrome.js" defer></script>
  <script src="/scripts/time-mode.js" defer></script>
</body>
</html>
`.replace(/[ \t]+$/gm, '');
}

function preserveChrome(html, existing) {
  if (!existing) return html;
  for (const [start, end] of [
    ['<!-- site-chrome:start -->', '<!-- site-chrome:end -->'],
    ['<!-- site-footer:start -->', '<!-- site-footer:end -->'],
  ]) {
    const from = existing.indexOf(start);
    const to = existing.indexOf(end, from);
    if (from === -1 || to === -1) continue;
    const block = existing.slice(from, to + end.length);
    const outFrom = html.indexOf(start);
    const outTo = html.indexOf(end, outFrom);
    if (outFrom === -1 || outTo === -1) continue;
    html = html.slice(0, outFrom) + block + html.slice(outTo + end.length);
  }
  return html;
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  let changed = 0;
  const failures = [];
  for (const office of OFFICES) {
    const file = path.resolve(ROOT, office.file);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = preserveChrome(render(office), existing);
    if (next !== existing) {
      changed += 1;
      if (mode === 'write') fs.writeFileSync(file, next);
      else failures.push(`${office.file}: office page is stale (run node tools/office-pages.mjs --write)`);
    }
  }
  if (mode === 'write') console.log(`Office pages written: ${changed} of ${OFFICES.length}.`);
  else if (!failures.length) console.log(`Office pages are in sync: ${OFFICES.length}.`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

main();
