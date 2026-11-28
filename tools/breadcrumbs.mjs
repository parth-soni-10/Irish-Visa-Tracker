/**
 * Shared visible breadcrumbs and BreadcrumbList schema.
 *
 * The generated office, report, date and monthly pages already know their
 * hierarchy. Keeping the markup and the schema in one place stops the visible
 * trail from drifting away from the structured-data trail.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

/**
 * @param {{name: string, href?: string}[]} items ordered from the homepage to
 *   the current page. The final item is rendered as the current page.
 */
export function breadcrumbNav(items, label = 'Breadcrumb') {
  const list = (Array.isArray(items) ? items : []).map((item, index) => {
    const current = index === items.length - 1;
    const name = esc(item.name);
    const content = current || !item.href
      ? `<span${current ? ' aria-current="page"' : ''}>${name}</span>`
      : `<a href="${esc(item.href)}">${name}</a>`;
    return `<li>${content}</li>`;
  }).join('');
  return `<nav class="breadcrumbs" aria-label="${esc(label)}"><ol>${list}</ol></nav>`;
}
