/**
 * Application-assistant helpers: indicative fee quotes and text extraction
 * from a pasted decision/application page. The extraction is deliberately
 * conservative; it only reads text the user explicitly submits.
 */

const VISA_FEES = {
  single: { label: 'Single-entry visa', amount: 60 },
  multi: { label: 'Multiple-entry visa', amount: 100 },
  transit: { label: 'Transit visa', amount: 25 }
};

const OFFICE_FEES = {
  'new-delhi': { name: 'New Delhi', vfs: 20.5, biometrics: 0 },
  beijing: { name: 'Beijing', vfs: 20.5, biometrics: 0 },
  dublin: { name: 'Dublin', vfs: 0, biometrics: 0 },
  'abu-dhabi': { name: 'Abu Dhabi', vfs: 20.5, biometrics: 0 },
  abuja: { name: 'Abuja', vfs: 20.5, biometrics: 0 },
  ankara: { name: 'Ankara', vfs: 20.5, biometrics: 0 }
};

const OFFICE_ALIASES = {
  'new delhi': 'new-delhi',
  newdelhi: 'new-delhi',
  beijing: 'beijing',
  dublin: 'dublin',
  'abu dhabi': 'abu-dhabi',
  abudhabi: 'abu-dhabi',
  abuja: 'abuja',
  ankara: 'ankara'
};

const VISA_WORDS = [
  ['study', /study|student|course|college|university/i],
  ['work', /work|employment|critical skills|permit/i],
  ['family', /family|spouse|partner|join/i],
  ['visit', /visit|tourist|holiday|business/i],
  ['transit', /transit|onward/i],
  ['research', /research|researcher|phd/i]
];

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function quoteFees(input = {}) {
  const office = OFFICE_FEES[input.office] ? input.office : 'new-delhi';
  const entryType = VISA_FEES[input.entry_type] ? input.entry_type : 'single';
  const entries = Math.max(1, Math.min(20, Math.round(Number(input.entries) || 1)));
  const includeVfs = input.vfs !== false;
  const includeBiometrics = input.biometrics !== false;
  const expressPostal = Boolean(input.postal);
  const base = VISA_FEES[entryType];
  const officeInfo = OFFICE_FEES[office];
  const lineItems = [
    { label: base.label + ' × ' + entries, amount: roundMoney(base.amount * entries) }
  ];
  if (includeVfs && officeInfo.vfs) {
    lineItems.push({ label: 'VFS service fee (estimated) × ' + entries, amount: roundMoney(officeInfo.vfs * entries) });
  }
  if (includeBiometrics && officeInfo.biometrics) {
    lineItems.push({ label: 'Biometrics × ' + entries, amount: roundMoney(officeInfo.biometrics * entries) });
  }
  if (expressPostal) {
    lineItems.push({ label: 'Return courier (estimated)', amount: 15 });
  }
  return {
    office,
    office_name: officeInfo.name,
    entry_type: entryType,
    entries,
    currency: 'EUR',
    line_items: lineItems,
    total: roundMoney(lineItems.reduce((total, item) => total + item.amount, 0)),
    disclaimer: 'Indicative only. Embassy and VFS fees change; confirm the current fee on the official application page before paying.'
  };
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  let match = raw.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) {
    return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  }
  match = raw.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (match) {
    return match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0');
  }
  const long = raw.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  if (long) {
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    return long[3] + '-' + String(months.indexOf(long[2].toLowerCase()) + 1).padStart(2, '0') + '-' + long[1].padStart(2, '0');
  }
  return '';
}

function detectOffice(text) {
  const lower = String(text || '').toLowerCase();
  for (const [alias, slug] of Object.entries(OFFICE_ALIASES)) {
    if (lower.includes(alias)) return slug;
  }
  return '';
}

export function scanDocument(text) {
  const raw = String(text || '').slice(0, 30000);
  const applicationMatch = raw.match(/\b(?:IRL[\s:/-]*)?(\d{8,12})\b/i);
  const decisionMatch = raw.match(/\b(approved|granted|refused|rejected|in progress|pending)\b/i);
  const dateMatch = raw.match(/\b(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.](?:20\d{2})|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})\b/i);
  const visaType = VISA_WORDS.find(([, regex]) => regex.test(raw));
  const office = detectOffice(raw);
  const decision = decisionMatch
    ? (/approved|granted/i.test(decisionMatch[1]) ? 'Approved'
      : /refused|rejected/i.test(decisionMatch[1]) ? 'Refused'
        : 'Pending')
    : '';
  const fields = {
    application_number: applicationMatch ? applicationMatch[1] : '',
    decision,
    date: dateMatch ? normalizeDate(dateMatch[0]) : '',
    office,
    visa_type: visaType ? visaType[0] : ''
  };
  const present = Object.values(fields).filter(Boolean).length;
  const warnings = [];
  if (!fields.application_number) warnings.push('No 8–12 digit application number was found.');
  if (!fields.decision) warnings.push('No approved/refused/pending status was found.');
  if (!fields.date) warnings.push('No decision date was found.');
  if (!fields.office) warnings.push('The visa office was not detected.');
  if (!fields.visa_type) warnings.push('The visa type was not detected.');
  if (present < 3) warnings.push('This is not enough text for a reliable result. Try a clearer scan or paste the full text.');
  return {
    fields,
    confidence: Math.round((present / 5) * 100),
    warnings,
    text_length: raw.length
  };
}
