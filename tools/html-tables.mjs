/**
 * Give every generated table header an explicit scope.
 *
 * Screen readers infer a header's direction from its position, which breaks as
 * soon as a table has both column labels and row labels. The generators emit
 * plain `<th>` cells, so one pass over the rendered HTML marks header-row cells
 * `scope="col"` and each row's first cell `scope="row"`. An existing scope is
 * never overwritten.
 */

function withScope(match, openTag, attrs = '') {
  if (/\bscope=/.test(attrs)) return match;
  return openTag + '<th scope="row"' + attrs + '>';
}

export function scopeTableHeaders(html) {
  return String(html).replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    let out = table.replace(/<thead\b[\s\S]*?<\/thead>/gi, (head) =>
      head.replace(/<th(\s[^>]*)?>/gi, (match, attrs = '') =>
        /\bscope=/.test(attrs) ? match : `<th scope="col"${attrs}>`));
    // Row headers: the first cell of a row, outside the header block.
    out = out.replace(/(<tr\b[^>]*>\s*)<th(\s[^>]*)?>/gi, withScope);
    return out;
  });
}
