(function() {
        var scheduled = false;
        function needsIcons(node) {
            return node && node.nodeType === 1 &&
                ((node.matches && node.matches('[data-lucide]')) ||
                 (node.querySelector && node.querySelector('[data-lucide]')));
        }
        function hydrate() {
            scheduled = false;
            if (!window.lucide || !document.querySelector('[data-lucide]')) return;
            lucide.createIcons({ nameAttr: 'data-lucide', attrs: { 'aria-hidden': 'true' } });
            // Lucide keeps data-lucide on the generated SVG. Remove it so the
            // next observer pass cannot replace the same icon forever.
            document.querySelectorAll('svg[data-lucide]').forEach(function(svg) {
                svg.removeAttribute('data-lucide');
            });
        }
        function schedule() {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(hydrate);
        }
        if (window.MutationObserver) {
            new MutationObserver(function(mutations) {
                for (var i = 0; i < mutations.length; i += 1) {
                    var added = mutations[i].type === 'childList' ? mutations[i].addedNodes : [];
                    for (var j = 0; j < added.length; j += 1) {
                        if (needsIcons(added[j])) {
                            schedule();
                            return;
                        }
                    }
                }
            }).observe(document.body, { subtree: true, childList: true });
        }
        hydrate();
    })();
