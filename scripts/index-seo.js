/* Dataset.dateModified describes the data, so it is derived from the data at
     read time rather than frozen at whichever date the HTML was last edited.
     The static value stays as the no-JS fallback. */
  (function () {
    var tag = document.querySelector('script[type="application/ld+json"]');
    if (!tag) return;
    fetch('/data/visa_meta.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (meta) {
        if (!meta || !meta.lastRunAt) return;
        var day = String(meta.lastRunAt).slice(0, 10);
        var graph;
        try { graph = JSON.parse(tag.textContent); } catch (e) { return; }
        var nodes = graph['@graph'] || [graph];
        var changed = false;
        nodes.forEach(function (n) {
          if (n && n['@type'] === 'Dataset' && n.dateModified) { n.dateModified = day; changed = true; }
        });
        if (changed) tag.textContent = JSON.stringify(graph);
      });
  })();
