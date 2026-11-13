(function() {
        function go() { if (window.lucide) lucide.createIcons({ nameAttr: 'data-lucide', attrs: { 'aria-hidden': 'true' } }); }
        if (window.MutationObserver) new MutationObserver(function(){ setTimeout(go, 0); }).observe(document.body, { subtree: true, childList: true });
        go();
    })();
