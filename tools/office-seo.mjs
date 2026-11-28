// Office page search metadata. Both the checked-in page generator and the
// build-time injector read this map so the title/description do not drift.
export const OFFICE_SEO = {
  'new-delhi': {
    // India carries the largest impression count in Search Console, so the
    // country leads the snippet instead of trailing four country names.
    title: 'New Delhi Ireland Visa Decisions — India',
    description: 'Latest New Delhi Ireland visa decisions for India, Bangladesh, Nepal and Sri Lanka, with approved and refused counts, processing times and a free number search.',
  },
  beijing: {
    title: 'Beijing Ireland Visa Decisions — China',
    description: 'Search Ireland visa decisions for China, Hong Kong, Macau and Mongolia in the latest Beijing snapshot, with approved and refused counts.',
  },
  'abu-dhabi': {
    title: 'Abu Dhabi Ireland Visa Decisions — UAE',
    description: 'Search Ireland visa decisions for the UAE and Gulf states in the latest Abu Dhabi report, with approved and refused counts.',
  },
  abuja: {
    title: 'Abuja Ireland Visa Decisions — Nigeria',
    description: 'Search Ireland visa decisions for Nigeria, Ghana, Côte d’Ivoire and Senegal in the latest Abuja report, with weekly approved and refused counts.',
  },
  ankara: {
    title: 'Ankara Ireland Visa Decisions — Türkiye',
    description: 'Search Ireland visa decisions for Türkiye, Azerbaijan and Saudi residents in the latest Ankara report, with approved, refused and OCR notes.',
  },
  dublin: {
    title: 'Dublin Ireland Visa Decisions — Pakistan',
    description: 'Search Ireland visa decisions for Pakistan and files transferred to Dublin, with Tuesday updates, approved and refused counts and scope.',
  },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A compact date for a search-result title, e.g. 27 Nov 2026. */
export function compactDate(value) {
  const raw = String(value || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return '';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** Office intent plus the latest publication date, capped for a search result. */
export function officeTitle(slug, latest = '') {
  const base = (OFFICE_SEO[slug] && OFFICE_SEO[slug].title) || 'Ireland Visa Decisions';
  const date = compactDate(latest);
  return date ? `${base} — ${date}` : base;
}
