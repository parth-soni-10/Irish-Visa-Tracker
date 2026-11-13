(function() {
            // Static data files committed by the scraper workflow - no backend,
            // no secrets, no configuration. Same shape the Apps Script API
            // used to serve, so every render path below is untouched.
            const VISA_DATA_URL = 'data/visa_decisions.json';
            const VISA_META_URL = 'data/visa_meta.json';
            const TRACKING_STARTED = '2026-07-13';
            const EXCLUDE_FROM_AVERAGES = '2026-07-12';
            const CACHE_FRESH_MS = 5 * 60 * 1000;
            const NO_UPLOAD_MESSAGE = "Visa office hasn't uploaded any sheet until now, check back later, or come back tomorrow";
            const WEEKEND_MESSAGE = "Saturday/Sunday, Visa Office is closed";

            // Boot-time device-capability detector. Runs once at the top of
            // the IIFE (the page is already parsing this script which lives
            // at the end of <body>, so document.body exists). Sets:
            //   body[data-env]      = "desktop" | "touch" | "hybrid"
            //   body[data-canHover] = "1" or "0"
            // so the CSS layer can target them. Listens for capability
            // change (e.g. external mouse/keyboard plugged into iPad) so
            // the data attributes update without a reload.
            (function() {
                function detect() {
                    var hov = window.matchMedia && window.matchMedia('(hover: hover)').matches;
                    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
                    var env = (hov && !coarse) ? 'desktop' : coarse ? 'touch' : 'hybrid';
                    var b = document.body;
                    if (b) {
                        b.dataset.env = env;
                        b.dataset.canHover = hov ? '1' : '0';
                    }
                }
                detect();
                var mqH = window.matchMedia && window.matchMedia('(hover: hover)');
                var mqP = window.matchMedia && window.matchMedia('(pointer: coarse)');
                if (mqH && mqH.addEventListener) mqH.addEventListener('change', detect);
                if (mqP && mqP.addEventListener) mqP.addEventListener('change', detect);
            })();

            // ===== LazyLoader: on-demand loading of heavy libraries =====
            // Provides promise-based loading with deduplication and error handling
            const LazyLoader = (function() {
                const loaded = new Map();
                const loading = new Map();

                function loadScript(src, globalVar) {
                    // Always hand back a promise: cached loads store the resolved value,
                    // and callers (paintAnalyticsCharts) chain .then on the result.
                    if (loaded.has(src)) return Promise.resolve(loaded.get(src));
                    if (loading.has(src)) return loading.get(src);

                    const promise = new Promise((resolve, reject) => {
                        if (document.querySelector('script[src="' + src + '"]')) {
                            // Script already in DOM, wait for it to be ready
                            const checkReady = setInterval(() => {
                                if (globalVar && window[globalVar]) {
                                    clearInterval(checkReady);
                                    resolve(window[globalVar]);
                                } else if (!globalVar) {
                                    clearInterval(checkReady);
                                    resolve();
                                }
                            }, 50);
                            return;
                        }

                        const script = document.createElement('script');
                        script.src = src;
                        script.async = true;
                        script.onload = () => {
                            if (globalVar && window[globalVar]) {
                                resolve(window[globalVar]);
                            } else {
                                resolve();
                            }
                        };
                        script.onerror = (err) => reject(new Error('Failed to load ' + src));
                        document.head.appendChild(script);
                    });

                    loading.set(src, promise);
                    promise.then(
                        (val) => { loaded.set(src, val); loading.delete(src); },
                        (err) => { loading.delete(src); throw err; }
                    );
                    return promise;
                }

                return {
                    // Chart.js v4
                    chart: () => loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'Chart'),
                    
                    // SheetJS (xlsx) for Excel export
                    xlsx: () => loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX'),
                    
                    // jsPDF for PDF export
                    jspdf: () => loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', 'jspdf'),
                    
                    // jsPDF autoTable plugin
                    jspdfAutotable: () => loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.1/dist/jspdf.plugin.autotable.min.js'),
                    
                    // Generic script loader
                    load: (src, globalVar) => loadScript(src, globalVar),
                    
                    // Check if already loaded
                    isLoaded: (src) => loaded.has(src),
                    
                    // Preload multiple libraries in parallel
                    preload: (...sources) => Promise.all(sources.map(([src, globalVar]) => loadScript(src, globalVar)))
                };
            })();

            const root = document.getElementById('visa-dash');
            let cache = null;

            // WCAG: scrollable regions must be keyboard-focusable (Safari).
            function ensureScrollableFocusable() {
                document.querySelectorAll('#visa-dash .table-wrap').forEach(function(el) {
                    if (el.getAttribute('tabindex') === null) {
                        el.setAttribute('tabindex', '0');
                        el.setAttribute('role', 'region');
                        if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'Results table');
                    }
                });
            }
            let cacheFetchedAt = null;
            let dataPromise = null;
            let theme = localStorage.getItem('visa-theme') || 'light';

            // ---- account / watchlist state (item 1) ----
            // Cookie-based session: the backend sets an httpOnly session_id
            // cookie on login, so every fetch to /api/auth/* includes it
            // automatically (credentials: 'include').
            let currentUser = null;
            let authChecked = false;

            // ---- activation funnel ----
            var ACTIVATION_KEY = 'visa-activation-v1';
            function readActivation() {
                try { return JSON.parse(localStorage.getItem(ACTIVATION_KEY) || '{}') || {}; } catch { return {}; }
            }
            function markActivation(step) {
                var state = readActivation();
                if (state[step]) return;
                state[step] = true;
                try { localStorage.setItem(ACTIVATION_KEY, JSON.stringify(state)); } catch {}
                paintActivation();
                trackConversion('activation_step_completed', 'checklist', { step: step });
            }
            function paintActivation() {
                var state = readActivation();
                document.querySelectorAll('[data-activation-step]').forEach(function(item) {
                    item.classList.toggle('done', Boolean(state[item.getAttribute('data-activation-step')]));
                });
            }
            function trackConversion(event, source, details) {
                try {
                    if (event === 'alert_cta_view') {
                        var seen = 'visa-conversion-' + source;
                        if (sessionStorage.getItem(seen)) return;
                        sessionStorage.setItem(seen, '1');
                    }
                } catch { /* storage can be disabled */ }
                var payload = JSON.stringify({ event: event, source: source || 'web' });
                if (navigator.sendBeacon) {
                    try {
                        if (navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }))) return;
                    } catch { /* fall through to fetch */ }
                }
                fetch('/api/events', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload,
                    keepalive: true
                }).catch(function() {});
            }
            function openAlertForm(kind) {
                trackConversion(kind === 'telegram' ? 'alert_telegram_click' : 'alert_email_click', 'activation');
                // `suggest` is the registered tab id in KNOWN_TABS; using
                // "suggestions" here renders the form but writes a URL that
                // reloads to the landing page.
                switchTab('suggest');
                setTimeout(function() {
                    var form = document.getElementById('alert-form');
                    if (!form) return;
                    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    var focus = form.querySelector(kind === 'telegram' ? '#telegram-alert-btn' : 'input[name="email"]');
                    if (focus) focus.focus({ preventScroll: true });
                }, 80);
            }

            async function fetchAuth() {
                if (authChecked) return currentUser;
                authChecked = true;
                try {
                    const res = await fetch('/api/auth/me', {
                        method: 'GET',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.authenticated && data.user) currentUser = data.user;
                    }
                } catch (e) {
                    // Offline or backend down: stay signed out.
                }
                return currentUser;
            }

            function accountBtnHTML() {
                if (currentUser) {
                    return '<button type="button" class="export-btn tu-btn" id="account-btn" title="Account: ' +
                        escapeHtml(currentUser.email) + '"><i data-lucide="user" aria-hidden="true"></i> ' +
                        escapeHtml(currentUser.name || currentUser.email) + '</button>' +
                        '<button type="button" class="export-btn tu-btn" id="signout-btn" title="Sign out"><i data-lucide="log-out" aria-hidden="true"></i> Sign out</button>';
                }
                return '<button type="button" class="export-btn tu-btn" id="account-btn" title="Sign in"><i data-lucide="user" aria-hidden="true"></i> Sign in</button>';
            }

            var _modalReturnFocus = null;
            var _modalKeyHandlerBound = false;
            function modalFocusable(m) {
                return Array.prototype.filter.call(
                    m.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
                    function(el) { return el.offsetParent !== null && !el.hidden; }
                );
            }
            function bindModalKeyboard() {
                if (_modalKeyHandlerBound) return;
                _modalKeyHandlerBound = true;
                document.addEventListener('keydown', function(e) {
                    var m = document.getElementById('account-modal');
                    if (!m || m.hidden) return;
                    if (e.key === 'Escape') { e.preventDefault(); closeAccountModal(); return; }
                    if (e.key !== 'Tab') return;
                    var items = modalFocusable(m);
                    if (!items.length) return;
                    var first = items[0];
                    var last = items[items.length - 1];
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                });
            }

            async function openAccountModal() {
                var m = document.getElementById('account-modal');
                _modalReturnFocus = document.activeElement;
                m.hidden = false;
                m.setAttribute('aria-hidden', 'false');
                bindModalKeyboard();
                showAccountTab('signin');
                setTimeout(function() {
                    var first = modalFocusable(m)[0];
                    if (first) first.focus();
                }, 0);
                // Resolve sign-in state in the background so the modal opens
                // immediately even if the auth fetch is slow.
                await fetchAuth();
                var tools = document.getElementById('account-tools');
                var tabs = document.querySelector('#account-modal .modal-tabs');
                if (currentUser) {
                    document.getElementById('account-form-signin').hidden = true;
                    document.getElementById('account-form-register').hidden = true;
                    if (tools) tools.hidden = false;
                    if (tabs) tabs.hidden = true;
                    document.getElementById('account-modal-title').textContent =
                        'Signed in as ' + escapeHtml(currentUser.email);
                    var status = document.getElementById('account-signin-status');
                    if (status) status.textContent = '';
                    loadAPITokens();
                } else {
                    if (tools) tools.hidden = true;
                    if (tabs) tabs.hidden = false;
                }
            }

            function closeAccountModal() {
                var m = document.getElementById('account-modal');
                if (m) { m.hidden = true; m.setAttribute('aria-hidden', 'true'); }
                if (_modalReturnFocus && typeof _modalReturnFocus.focus === 'function') _modalReturnFocus.focus();
                _modalReturnFocus = null;
            }

            function showAccountTab(tab) {
                var signin = document.getElementById('account-form-signin');
                var register = document.getElementById('account-form-register');
                var tSignin = document.getElementById('account-tab-signin');
                var tRegister = document.getElementById('account-tab-register');
                var tools = document.getElementById('account-tools');
                if (tools) tools.hidden = true;
                if (tab === 'register') {
                    if (signin) { signin.hidden = true; signin.setAttribute('aria-hidden', 'true'); }
                    if (register) { register.hidden = false; register.setAttribute('aria-hidden', 'false'); }
                    if (tSignin) tSignin.setAttribute('aria-selected', 'false');
                    if (tRegister) tRegister.setAttribute('aria-selected', 'true');
                } else {
                    if (signin) { signin.hidden = false; signin.setAttribute('aria-hidden', 'false'); }
                    if (register) { register.hidden = true; register.setAttribute('aria-hidden', 'true'); }
                    if (tSignin) tSignin.setAttribute('aria-selected', 'true');
                    if (tRegister) tRegister.setAttribute('aria-selected', 'false');
                }
            }

            // The modal markup uses inline handlers, but this script is wrapped
            // in a closure. Expose the controls those handlers call; without
            // this the Create account tab, close button and backdrop were dead.
            window.showAccountTab = showAccountTab;
            window.closeAccountModal = closeAccountModal;

            async function sendPushTest() {
                var status = document.getElementById('push-test-status');
                var button = document.getElementById('push-test-btn');
                if (!status) return;
                if (button) button.disabled = true;
                status.style.color = '';
                status.textContent = 'Sending test notification\u2026';
                try {
                    var response = await fetch('/api/user/push/test', { method: 'POST', credentials: 'include' });
                    var data = await response.json().catch(function() { return {}; });
                    if (!response.ok) throw new Error(data.error || 'Test notification failed');
                    status.textContent = 'Test sent to ' + (data.sent || 0) + ' subscription(s).';
                    status.style.color = 'var(--green)';
                } catch (error) {
                    status.textContent = error.message;
                    status.style.color = 'var(--red)';
                } finally {
                    if (button) button.disabled = false;
                }
            }

            window.sendPushTest = sendPushTest;

            async function handleAccountForm(e) {
                e.preventDefault();
                var form = e.target;
                var status = form.querySelector('.note');
                var btn = form.querySelector('button[type="submit"]');
                var fd = new FormData(form);
                var body = {};
                for (var pair of fd) body[pair[0]] = pair[1];
                var isRegister = form.id === 'account-form-register';
                var endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
                btn.disabled = true;
                status.textContent = isRegister ? 'Creating account…' : 'Signing in…';
                try {
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const data = await res.json();
                    if (res.ok) {
                        closeAccountModal();
                        authChecked = false;
                        await fetchAuth();
                        wireChrome();
                        render();
                        if (status) status.textContent = isRegister ? 'Account created.' : 'Signed in.';
                    } else {
                        status.textContent = (data && data.error) || 'Failed.';
                        status.style.color = 'var(--red)';
                    }
                } catch (err) {
                    status.textContent = 'Network error.';
                    status.style.color = 'var(--red)';
                } finally {
                    btn.disabled = false;
                }
            }

            async function signOut() {
                try {
                    await fetch('/api/auth/logout', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' }
                    });
                } catch (e) { /* ignore */ }
                currentUser = null;
                authChecked = false;
                closeAccountModal();
                wireChrome();
                render();
            }

            // ---- server watchlist (item 1) ----
            async function fetchWatchlist() {
                if (!currentUser) return [];
                try {
                    const res = await fetch('/api/user/watchlist', {
                        method: 'GET',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        return Array.isArray(data.watchlist) ? data.watchlist : [];
                    }
                } catch (e) { /* offline */ }
                return [];
            }

            async function addToServerWatchlist(appNum, embassySlug, nickname) {
                if (!currentUser) return false;
                try {
                    const res = await fetch('/api/user/watchlist', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            application_number: appNum,
                            embassy_slug: embassySlug || 'new-delhi',
                            nickname: nickname || null,
                            notify_email: true,
                            notify_push: true
                        })
                    });
                    return res.ok;
                } catch (e) { return false; }
            }

            async function removeFromServerWatchlist(id) {
                if (!currentUser) return false;
                try {
                    const res = await fetch('/api/user/watchlist/' + encodeURIComponent(id), {
                        method: 'DELETE',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    return res.ok;
                } catch (e) { return false; }
            }

            // Local (anonymous) watchlist helpers delegate to the existing
            // getWatchlist/saveWatchlist/checkWatchlist.



            // ---------------- URL state (deep-linkable views) ----------------
            // Tabs, the Home search term, and the Past date filter live in the
            // query string, so every view can be bookmarked/shared and survives
            // reloads. Tab switches push history entries; search/date updates
            // replace the current one (no per-keystroke history spam).
            const KNOWN_TABS = ['home', 'daily', 'past', 'suggest', 'watchlist', 'checklist', 'search'];
            // Top-level tracker: 'home' is the landing screen with the two
            // tracker cards, 'visa' the embassy-decisions tracker, '1g' the
            // Stamp 1G processing-date tracker. Old shared links carry only
            // ?tab=… - those resolve to 'visa' so nothing breaks.
            const KNOWN_TRACKERS = ['home', 'visa', '1g', 'permits'];
            // Which decisions the Past table can be narrowed to. Declared before
            // readUrlState() runs, because the reader restores it from the URL.
            const PAST_STATUSES = ['all', 'accepted', 'rejected', 'pending'];

            function readUrlState() {
                const p = new URLSearchParams(location.search);
                const tab = p.get('tab');
                const tracker = p.get('tracker');
                let resolved = 'home';
                if (tracker && KNOWN_TRACKERS.indexOf(tracker) !== -1) resolved = tracker;
                else if (tab && KNOWN_TABS.indexOf(tab) !== -1) resolved = 'visa';
                return {
                    tracker: resolved,
                    tab: KNOWN_TABS.indexOf(tab) !== -1 ? tab : 'home',
                    q: (p.get('q') || '').slice(0, 200),
                    date: (p.get('date') || '').slice(0, 10),
                    status: PAST_STATUSES.indexOf(p.get('status')) !== -1 ? p.get('status') : 'all'
                };
            }
            function syncUrl(mode) {
                const p = new URLSearchParams();
                if (activeTracker === 'visa') {
                    p.set('tracker', 'visa');
                    p.set('tab', activeTab);
                    if (homeSearchTerm) p.set('q', homeSearchTerm);
                    if (pastDateFilter) p.set('date', pastDateFilter);
                    if (pastStatusFilter !== 'all') p.set('status', pastStatusFilter);
                } else if (activeTracker === '1g') {
                    p.set('tracker', '1g');
                } else if (activeTracker === 'permits') {
                    p.set('tracker', 'permits');
                }
                // Landing ('home') keeps a clean URL with no params.
                const qs = p.toString();
                history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', location.pathname + (qs ? '?' + qs : ''));
            }
            const urlState = readUrlState();
            let activeTracker = urlState.tracker;
            let activeTab = urlState.tab;
            let homeSearchTerm = urlState.q;
            let pastDateFilter = urlState.date;
            // Kept beside the date filter: the two narrow the same rows and share
            // the URL - ?tab=past&status=accepted&date=2026-10-01.
            let pastStatusFilter = urlState.status;

            // ---- visit tracking + stale-data state ----
            let lastVisitAt = Number(localStorage.getItem('visa-last-visit') || '0') || 0;
            let visited = false;
            let staleAt = null; // data being shown is from this timestamp (live refresh failed)

            function classify(decision) {
                const s = (decision || '').toLowerCase();
                if (/(approv|grant|accept|issu)/.test(s)) return 'accepted';
                if (/(refus|reject|deny|denied)/.test(s)) return 'rejected';
                return 'other';
            }

            // A "placeholder" row is a notice the scraper writes for a date that
            // has no decisions file yet (or the office is closed) - NOT an
            // application. The scraper keys them with an IRL of "NO_FILE_<date>";
            // message-based checks catch any older/odd rows as a fallback.
            function isPlaceholderRow(r) {
                if (!r) return false;
                const irl = String(r.irl || '').trim();
                const decision = String(r.decision || '').trim();
                if (irl.indexOf('NO_FILE_') === 0) return true;
                if (decision === NO_UPLOAD_MESSAGE || decision === WEEKEND_MESSAGE) return true;
                if (decision.indexOf('Embassy is closed') === 0) return true;
                return false;
            }

            // Visa type detection heuristic
            const VISA_TYPE_RANGES = {
                study: [ { min: 80000000, max: 89999999, confidence: 0.7, subtype: 'Stamp 2/2A' }, { min: 90000000, max: 99999999, confidence: 0.6, subtype: 'Stamp 2/2A' } ],
                work: [ { min: 50000000, max: 69999999, confidence: 0.6, subtype: 'Stamp 1/1G/4' }, { min: 70000000, max: 79999999, confidence: 0.5, subtype: 'Stamp 1/1H' } ],
                visit: [ { min: 10000000, max: 29999999, confidence: 0.7, subtype: 'Short Stay C' }, { min: 30000000, max: 49999999, confidence: 0.6, subtype: 'Short Stay C' } ],
                family: [ { min: 40000000, max: 59999999, confidence: 0.5, subtype: 'Stamp 3/4' } ],
                transit: [ { min: 1000000, max: 9999999, confidence: 0.8, subtype: 'Transit' } ],
                research: [ { min: 60000000, max: 69999999, confidence: 0.4, subtype: 'Research/Scientific' } ]
            };
            const EMBASSY_VISA_FOCUS = {
                'new-delhi': ['study', 'work', 'visit', 'family'],
                'beijing': ['study', 'visit', 'work'],
                'dublin': ['work', 'family', 'transfer'],
                'abu-dhabi': ['visit', 'work', 'family'],
                'abuja': ['visit', 'family', 'study'],
                'ankara': ['visit', 'work', 'family']
            };

            function detectVisaType(appNum, embassySlug) {
                const num = parseInt(appNum, 10);
                if (isNaN(num)) return { type: 'unknown', confidence: 0, subtype: '' };
                let best = { type: 'unknown', confidence: 0, subtype: '' };
                for (const [type, ranges] of Object.entries(VISA_TYPE_RANGES)) {
                    for (const range of ranges) {
                        if (num >= range.min && num <= range.max) {
                            let conf = range.confidence;
                            if (embassySlug && EMBASSY_VISA_FOCUS[embassySlug]?.includes(type)) conf += 0.15;
                            if (conf > best.confidence) best = { type, confidence: Math.min(conf, 0.95), subtype: range.subtype };
                        }
                    }
                }
                return best;
            }

            // Real application rows only (filters placeholder notices out).
            function realRows(list) {
                return (list || []).filter(function(r) { return !r._placeholder; });
            }

            function placeholderIcon() {
                return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg>';
            }

            function placeholderNote(message) {
                return '<span class="ph-msg">' + placeholderIcon() + '<span>' +
                    escapeHtml(message || 'No update for this date') + '</span></span>';
            }

            // Precompute status + cell HTML once per row at fetch time so render
            // paths become pure filter + string concatenation (no regex per keystroke).
            function preloadRow(r) {
                if (r._html) return r;
                const c = classify(r.decision);
                r._status = c;
                r._pillClass = c === 'accepted' ? 'green' : c === 'rejected' ? 'red' : 'amber';
                r._placeholder = isPlaceholderRow(r);
                
                // Visa type detection
                if (!r._placeholder && r.irl) {
                    const detection = detectVisaType(r.irl, r.embassy);
                    r._visaType = detection.type;
                    r._visaSubtype = detection.subtype;
                    r._visaConfidence = detection.confidence;
                }
                
                if (r._placeholder) {
                    // Notice rows render their message, not an application number.
                    r._html = '<tr class="ph-row"><td class="mono">' + r.date + '</td><td colspan="2">' +
                        placeholderNote(r.decision) + '</td></tr>';
                } else {
                    r._html = '<tr><td class="mono">' + r.date + '</td><td class="mono">' + r.irl +
                        '</td><td><span class="pill ' + r._pillClass + '">' + (r.decision || '-') + '</span></td></tr>';
                }
                return r;
            }

            function escapeHtml(value) {
                return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[ch]));
            }

            const _pctFmt = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });
            function fmtPct(n) { return isFinite(n) ? _pctFmt.format(n) : '-'; }
            // Localised short month names for the hero date ranges (no hardcoded
            // month arrays - Intl.DateTimeFormat owns locale + format).
            const _monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' });
            function shortMonth(d) { return _monthFmt.format(d); }

            function daysAgo(dateStr) { return Math.floor((Date.now() - new Date(dateStr + 'T00:00:00')) / 86400000); }

            function weekdayLong(dateStr) {
                const d = new Date(dateStr + 'T00:00:00');
                return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            }

            // ---- Home status lines: publish-time awareness + since-last-visit ----
            // IST = UTC+5:30; a Date shifted by 5.5h makes toISOString() read as IST.
            function istNow() {
                return new Date(Date.now() + 330 * 60000);
            }
            function publishStatusHTML(rows) {
                const ist = istNow();
                const istDate = ist.toISOString().slice(0, 10);
                const hhmm = ist.toISOString().slice(11, 16);
                const wd = ist.getUTCDay();
                if (wd === 0 || wd === 6) {
                    return '<div class="status-line">Embassy closed today (' + weekdayLong(istDate) +
                        '). The next file is expected Monday after <strong>11:00 AM IST</strong>.</div>';
                }
                const todayReal = rows.filter(r => !r._placeholder && r.date === istDate);
                if (todayReal.length) {
                    return '<div class="status-line pub-live">Today\u2019s file: <strong>published</strong>, ' +
                        todayReal.length + ' decision' + (todayReal.length === 1 ? '' : 's') + ' recorded today.</div>';
                }
                if (hhmm < '11:00') {
                    return '<div class="status-line">Today\u2019s file: <strong>expected at 11:00 AM IST</strong> (now ' + hhmm + ' IST).</div>';
                }
                return '<div class="status-line pub-late">Today\u2019s file: <strong>not published yet</strong>. ' +
                    'It usually appears by 11:00 AM IST; check back after 11:15.</div>';
            }
            function localDateStr(ts) {
                const d = new Date(ts);
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return d.getFullYear() + '-' + m + '-' + day;
            }
            function sinceBannerHTML(rows) {
                if (!lastVisitAt) return '';
                const fresh = rows.filter(r => !r._placeholder && r.date > localDateStr(lastVisitAt));
                if (!fresh.length) return '';
                const refused = fresh.filter(r => classify(r.decision) === 'rejected').length;
                const d = new Date(lastVisitAt);
                const when = d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                return '<div class="status-line pub-live">Since you last checked (' + when + '): <strong>' + fresh.length +
                    ' new decision' + (fresh.length === 1 ? '' : 's') + '</strong>' +
                    (refused ? ' \u00b7 ' + refused + ' refused' : '') + '.</div>';
            }
            function markVisited() {
                if (visited || !cache || !cache.length) return;
                visited = true;
                lastVisitAt = Date.now();
                try { localStorage.setItem('visa-last-visit', String(lastVisitAt)); } catch (e) { /* private mode */ }
            }

            // ---- last-known-good cache: survive backend hiccups ----
            // The latest successful fetch is snapshotted to localStorage so a
            // failed refresh shows real (stale) data with a banner instead of an
            // empty page. The history JSON is ~2.1MB and grows daily: stored
            // plain it would brush the ~5MB localStorage quota within months,
            // after which the write would throw and fail SILENTLY forever - the
            // fallback would quietly die. So the snapshot is gzipped with the
            // native CompressionStream (~10x smaller, ~200KB today) and base64'd
            // before storing. Browsers without CompressionStream fall back to
            // the plain legacy key, which restoreSnapshot still reads.
            const SNAPSHOT_GZ_KEY = 'visa-cache-gz';
            const SNAPSHOT_PLAIN_KEY = 'visa-cache';
            function bytesToBase64(bytes) {
                let bin = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                }
                return btoa(bin);
            }
            function base64ToBytes(b64) {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            }
            async function persistSnapshot(raw) {
                const json = JSON.stringify({ fetchedAt: Date.now(), rows: raw });
                try {
                    if (typeof CompressionStream !== 'undefined') {
                        const buf = await new Response(new Blob([json]).stream()
                            .pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
                        localStorage.setItem(SNAPSHOT_GZ_KEY, bytesToBase64(new Uint8Array(buf)));
                        // Legacy plain copy (bigger, older shape) is redundant now.
                        localStorage.removeItem(SNAPSHOT_PLAIN_KEY);
                    } else {
                        localStorage.setItem(SNAPSHOT_PLAIN_KEY, json);
                    }
                } catch (e) {
                    // Quota / private mode: keep the previous snapshot and make
                    // the failure visible instead of swallowing it.
                    console.warn('persistSnapshot failed - keeping previous snapshot:', e);
                }
            }
            async function restoreSnapshot() {
                try {
                    const gz = localStorage.getItem(SNAPSHOT_GZ_KEY);
                    if (gz) {
                        const text = await new Response(new Blob([base64ToBytes(gz)]).stream()
                            .pipeThrough(new DecompressionStream('gzip'))).text();
                        const snap = JSON.parse(text);
                        if (snap && Array.isArray(snap.rows) && snap.rows.length) return snap;
                    }
                } catch (e) { /* corrupted/unsupported - fall through to legacy key */ }
                try {
                    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_PLAIN_KEY) || 'null');
                    if (snap && Array.isArray(snap.rows) && snap.rows.length) return snap;
                } catch (e) { /* corrupted */ }
                return null;
            }
            function staleBannerHTML() {
                if (!staleAt) return '';
                const d = new Date(staleAt);
                const when = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                return '<div class="stale-banner" aria-live="polite">Showing data from ' + when +
                    '. Live refresh failed.' +
                    '<button type="button" class="stale-retry" id="stale-retry">Retry now</button></div>';
            }

            // ---- scraper health card (?action=meta) ----
            // The scraper stores a small run-status object after every run;
            // the card renders the last-scrape time, a sheet-vs-file
            // reconciliation line, and the embassy's closure calendar. Absent
            // or unreachable meta (older backend) just hides the card.
            let metaData = null;

            function fmtISTStamp(s) {
                // s is an IST wall-clock "YYYY-MM-DDTHH:MM:SS" from the scraper.
                const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
                const dt = new Date(Date.UTC(y, m - 1, d));
                const dateStr = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
                return dateStr + ', ' + String(s).slice(11, 16) + ' IST';
            }
            function fmtClosureDates(dates) {
                const parse = iso => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d, dt: new Date(Date.UTC(y, m - 1, d)) }; };
                const dayNum = p => p.dt.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' });
                const month = p => p.dt.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
                const parts = [];
                let i = 0;
                while (i < dates.length) {
                    let j = i;
                    while (j + 1 < dates.length && (parse(dates[j + 1]).dt - parse(dates[j]).dt) === 86400000) j++;
                    const a = parse(dates[i]), b = parse(dates[j]);
                    if (j === i) parts.push(dayNum(a) + ' ' + month(a));
                    else if (a.m === b.m) parts.push(dayNum(a) + '-' + dayNum(b) + ' ' + month(b));
                    else parts.push(dayNum(a) + ' ' + month(a) + ' - ' + dayNum(b) + ' ' + month(b));
                    i = j + 1;
                }
                return parts.join(', ');
            }
            async function loadMeta() {
                try {
                    const res = await fetch(VISA_META_URL);
                    if (!res.ok) return;
                    const m = await res.json();
                    if (m && typeof m === 'object' && m.lastRunAt) metaData = m;
                } catch (e) { /* pre-migration or outage - card stays hidden */ }
                renderMetaCard();
            }
            function renderMetaCard() {
                const box = document.getElementById('meta-box');
                if (!box || !metaData) return;
                const m = metaData;
                const html = [];
                const today = istNow().toISOString().slice(0, 10);
                const isToday = String(m.lastRunAt).slice(0, 10) === today;
                let dot = 'ok', health;
                if (m.ok === false) {
                    dot = 'bad';
                    health = 'Last scrape <strong>failed</strong> (' + fmtISTStamp(m.lastRunAt) + ')';
                } else if (isToday) {
                    health = 'Last scrape: <strong>' + fmtISTStamp(m.lastRunAt) + '</strong>' +
                        (m.newRows ? ' \u00b7 <strong>' + m.newRows + ' new</strong> rows' : ' \u00b7 no new rows');
                } else {
                    dot = 'stale';
                    health = 'Last scrape: <strong>' + fmtISTStamp(m.lastRunAt) + '</strong>. Nothing recorded today yet.';
                }
                html.push('<div class="meta-line"><span class="meta-dot ' + dot + '" aria-hidden="true"></span><span>' + health + '</span></div>');
                if (m.fileRows && m.sheetRows) {
                    const synced = m.sheetRows >= m.fileRows;
                    html.push('<div class="meta-line">Recorded <strong>' + m.sheetRows + '</strong> of <strong>' + m.fileRows +
                        '</strong> decisions in the latest file' + (m.fileDate ? ' (dated ' + m.fileDate + ')' : '') +
                        (synced ? '. Fully synced.' : '. ' + (m.fileRows - m.sheetRows) + ' still missing.') + '</div>');
                }
                if (m.closureDates && m.closureDates.length) {
                    const chips = fmtClosureDates(m.closureDates).split(', ').map(c =>
                        '<span class="closure-chip">' + escapeHtml(c) + '</span>').join('');
                    html.push('<div class="meta-line">Embassy closed: <span class="closure-chips">' + chips + '</span></div>');
                }
                box.innerHTML = '<div class="meta-card">' + html.join('') + '</div>';
            }

            function groupByDate(rows) {
                const m = new Map();
                rows.forEach(r => { if (!m.has(r.date)) m.set(r.date, []);
                    m.get(r.date).push(r); });
                return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
            }

            function avgDailyApps(byDate) {
                // Days that only contain placeholder notices (no decisions file)
                // are not "application days" - exclude them and their zero counts.
                var filtered = byDate.filter(function(e) {
                    if (e[0] === EXCLUDE_FROM_AVERAGES) return false;
                    return e[1].some(function(r) { return !r._placeholder; });
                });
                if (!filtered.length) return 0;
                var sum = 0;
                for (var i = 0; i < filtered.length; i++) {
                    sum += realRows(filtered[i][1]).length;
                }
                return sum / filtered.length;
            }

            async function loadData(options) {
                const force = options && options.force;
                // Return cached data only if it's still fresh AND we're not forcing a refresh.
                if (!force && cache !== null && cacheFetchedAt && (Date.now() - cacheFetchedAt < CACHE_FRESH_MS)) return cache;
                if (dataPromise) return dataPromise;
                dataPromise = (async () => {
                    try {
                        const res = await fetch(VISA_DATA_URL);
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        const raw = await res.json();
                        if (!Array.isArray(raw)) throw new Error('bad payload');
                        staleAt = null;
                        persistSnapshot(raw);
                        // Pre-compute classify + row HTML once per row, then sort by
                        // date desc so render paths are pure filter + string concat.
                        cache = raw.map(r => preloadRow(Array.isArray(r) ? { date: r[0], irl: r[1], decision: r[2] } : r));
                        // Apply visa type classification to all cached rows
                        cache.forEach(r => {
                            if (!r._placeholder && r.irl && !r._visaType) {
                                const detection = detectVisaType(r.irl, r.embassy);
                                r._visaType = detection.type;
                                r._visaSubtype = detection.subtype;
                                r._visaConfidence = detection.confidence;
                            }
                        });
                        cache.sort((a, b) => b.date.localeCompare(a.date));
                        cacheFetchedAt = Date.now();
                    } catch (e) {
                        console.warn('loadData failed:', e);
                        const snap = await restoreSnapshot();
                        if (snap) {
                            cache = snap.rows.map(r => preloadRow(Array.isArray(r) ? { date: r[0], irl: r[1], decision: r[2] } : r));
                            // Apply visa type classification to restored rows
                            cache.forEach(r => {
                                if (!r._placeholder && r.irl && !r._visaType) {
                                    const detection = detectVisaType(r.irl, r.embassy);
                                    r._visaType = detection.type;
                                    r._visaSubtype = detection.subtype;
                                    r._visaConfidence = detection.confidence;
                                }
                            });
                            cache.sort((a, b) => b.date.localeCompare(a.date));
                            cacheFetchedAt = snap.fetchedAt;
                            staleAt = snap.fetchedAt;
                        } else if (cache === null) cache = [];
                    } finally {
                        dataPromise = null;
                    }
                    return cache;
                })();
                return dataPromise;
            }


            function renderConfigWarning() {
                // No configuration step exists anymore (static data files) -
                // kept as a function so every layout call site is untouched.
                return '';
            }

            function searchIcon() {
                return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
            }

            function readmeSection() {
                return '<details class="readme"><summary class="readme-title">How this tracker works</summary>' +
                    '<p>Every day, an automated job checks the Irish embassy\'s New Delhi visa decisions page for the latest published spreadsheet and pulls any application numbers that haven\'t been recorded yet.</p>' +
                    '<ul>' +
                    '<li><strong>Home</strong>: today\'s snapshot, headline stats, and every result from the most recent file.</li>' +
                    '<li><strong>Daily summary</strong>: one row per day: volume, day-on-day change, acceptance and rejection rates.</li>' +
                    '<li><strong>Past results</strong>: full history, searchable by application number.</li>' +
                    '<li><strong>Suggestions</strong>: leave feedback. I check the suggestions and get back with a reply asap.</li>' +
                    '</ul>' +
                    '<p style="margin-top:12px;"><strong>After approval:</strong> Once your visa is approved, it is dispatched through <strong>BlueDart</strong> (in most cases) and follows standard courier delivery timelines from Delhi to your address.</p>' +
                    '</details>';
            }

            function activationSection() {
                return '<section class="activation" id="activation-card" aria-labelledby="activation-heading">' +
                    '<div>' +
                    '<p class="activation-kicker">Never miss a decision</p>' +
                    '<h2 id="activation-heading">Get your decision by email or Telegram</h2>' +
                    '<p class="activation-lede">Add your application once. The tracker checks the published files and only messages you when a decision appears. No refresh, no guessing.</p>' +
                    '<div class="activation-actions">' +
                    '<button type="button" class="btn" data-activation-action="email"><i data-lucide="mail" aria-hidden="true"></i> Get email alerts</button>' +
                    '<button type="button" class="btn activation-telegram" data-activation-action="telegram"><i data-lucide="send" aria-hidden="true"></i> Get Telegram alerts</button>' +
                    '</div>' +
                    '<p class="activation-meta">Free. Telegram needs no email address. Email alerts use double opt-in.</p>' +
                    '</div>' +
                    '<ol class="activation-checklist" aria-label="First-run checklist">' +
                    '<li data-activation-step="search"><span class="activation-num">1</span><div><strong>Find your application</strong><p>Search the latest published decision list.</p><button type="button" class="activation-link" data-activation-action="search">Search now</button></div></li>' +
                    '<li data-activation-step="watch"><span class="activation-num">2</span><div><strong>Save it to your watchlist</strong><p>Keep the application number with your account.</p><button type="button" class="activation-link" data-activation-action="watch">Open watchlist</button></div></li>' +
                    '<li data-activation-step="alerts"><span class="activation-num">3</span><div><strong>Choose a delivery channel</strong><p>Email or Telegram. One message per published decision.</p></div></li>' +
                    '</ol>' +
                    '</section>';
            }

            // ===== hero builder (Mockup C) - per-tab hero with real data =====
            function buildHeroHTML(tabId, rows) {
                const byDate = groupByDate(rows);
                const real = realRows(rows);
                const total = real.length;
                const accepted = real.filter(r => classify(r.decision) === 'accepted').length;
                const rejected = real.filter(r => classify(r.decision) === 'rejected').length;
                const accPct = total ? accepted / total : 0;
                const rejPct = total ? rejected / total : 0;
                const avg = avgDailyApps(byDate);
                // The newest day on record may be a placeholder notice; compute
                // the snapshot from the newest day that has REAL data.
                const latest = byDate.length ? byDate[0] : null;
                const latestPlaceholder = latest && !realRows(latest[1]).length ? latest[1][0] : null;
                const latestRealDay = byDate.find(function(d) { return realRows(d[1]).length; });
                const latestCount = latestRealDay ? realRows(latestRealDay[1]).length : 0;
                const prevRealDay = latestRealDay
                    ? byDate.slice(byDate.indexOf(latestRealDay) + 1).find(function(d) { return realRows(d[1]).length; })
                    : null;
                const dayDiff = prevRealDay ? latestCount - realRows(prevRealDay[1]).length : 0;

                const states = {
                    home: {
                        title: latestPlaceholder
                            ? 'No new outcomes yet.'
                            : latestCount + ' new outcomes today.',
                        sub: latestPlaceholder
                            ? (latestPlaceholder.decision || 'No new file published yet.')
                            : (dayDiff >= 0 ? '+' : '') + dayDiff + ' vs. yesterday, ' + fmtPct(accPct) + ' accepted.',
                        visual: latestPlaceholder
                            ? '<div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="ring-core">-</div>'
                            : '<div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="ring-core' + (String(latestCount).length > 3 ? ' big' : '') + '">' + latestCount + '</div>'
                    },
                    daily: {
                        title: byDate.length + ' days on record.',
                        sub: (function() {
                            // Mirror the Past hero: sub-text shows the actual
                            // date range so the user sees both totals AND the
                            // dates covered. Week boundary Sun -> Sat.
                            var _t = new Date();
                            var _ws = new Date(_t.getFullYear(), _t.getMonth(), _t.getDate() - _t.getDay());
                            var _we = new Date(_ws); _we.setDate(_ws.getDate() + 6);
                            return 'Avg ' + avg.toFixed(1) + ' applications/day, ' + fmtPct(accPct) + ' accepted, week of ' +
                                   shortMonth(_ws) + ' ' + _ws.getDate() + '-' + shortMonth(_we) + ' ' + _we.getDate() + '.';
                        })(),
                        visual: (function() {
                            // Current calendar week (Sun -> Sat) containing
                            // today, matching the Past hero's window. weekStart
                            // is the most-recent Sunday on or before today; we
                            // look each of 7 days up in a byDate Map. Missing
                            // days render as zero-height bars.
                            var today = new Date();
                            var weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
                            var byDateMap = new Map(byDate);
                            var weekDays = [];
                            for (var wi = 0; wi < 7; wi++) {
                                var d = new Date(weekStart);
                                d.setDate(weekStart.getDate() + wi);
                                var ds = d.getFullYear() + '-' +
                                         String(d.getMonth() + 1).padStart(2, '0') + '-' +
                                         String(d.getDate()).padStart(2, '0');
                                weekDays.push([ds, byDateMap.get(ds) || []]);
                            }
                            var maxApps = Math.max.apply(null, weekDays.map(function(d) { return realRows(d[1]).length; }).concat([1]));
                            return '<div class="wave">' + weekDays.map(function(d, i) {
                                var dayRows = realRows(d[1]);
                                return '<div class="wave-bar" style="height:' + Math.max(8, (dayRows.length / maxApps) * 120) + 'px; animation-delay:' + (i * 0.07) + 's"></div>';
                            }).join('') + '</div>';
                        })()
                    },
                    past: {
                        title: 'Accepted and rejected, side by side.',
                        sub: (function() {
                            // Sub-text mirrors the chart's week range so the user
                            // sees both the totals AND the exact dates covered.
                            // Week boundary is Sunday -> Saturday (matches the
                            // Sun-first days[] array elsewhere in this file).
                            var _t = new Date();
                            var _ws = new Date(_t.getFullYear(), _t.getMonth(), _t.getDate() - _t.getDay());
                            var _we = new Date(_ws); _we.setDate(_ws.getDate() + 6);
                            return fmtPct(accPct) + ' accepted, ' + fmtPct(rejPct) + ' rejected, ' + total.toLocaleString() + ' total, ' +
                                   'week of ' + shortMonth(_ws) + ' ' + _ws.getDate() + '-' + shortMonth(_we) + ' ' + _we.getDate() + '.';
                        })(),
                        visual: (function() {
                            // Current calendar week (Sun -> Sat) containing today,
                            // not the rolling last 7 calendar days. weekStart is
                            // the most-recent Sunday on or before today; iterate
                            // 7 days forward and look each one up in a byDate
                            // Map. Missing days (no decisions yet, or future
                            // days in this week) render as empty bars.
                            var today = new Date();
                            var weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
                            var byDateMap = new Map(byDate);
                            var last7 = [];
                            for (var wi = 0; wi < 7; wi++) {
                                var d = new Date(weekStart);
                                d.setDate(weekStart.getDate() + wi);
                                var ds = d.getFullYear() + '-' +
                                         String(d.getMonth() + 1).padStart(2, '0') + '-' +
                                         String(d.getDate()).padStart(2, '0');
                                last7.push([ds, byDateMap.get(ds) || []]);
                            }
                            var maxVal = Math.max.apply(null, last7.map(function(d) {
                                var dr = d[1];
                                return dr.filter(function(r) { return classify(r.decision) === 'accepted'; }).length +
                                       dr.filter(function(r) { return classify(r.decision) === 'rejected'; }).length;
                            }).concat([1]));
                            var scale = Math.min(1, 104 / Math.max(maxVal, 1));
                            var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                            return '<div class="wf">' + last7.map(function(d, i) {
                                var dayRows = d[1];
                                var acc = dayRows.filter(function(r) { return classify(r.decision) === 'accepted'; }).length;
                                var rej = dayRows.filter(function(r) { return classify(r.decision) === 'rejected'; }).length;
                                var total = acc + rej;
                                var accPct = total ? Math.round(acc / total * 100) : 0;
                                var parts = d[0].split('-');
                                var dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                                var dateLabel = days[dateObj.getDay()] + ' ' + (dateObj.getDate() < 10 ? '0' + dateObj.getDate() : dateObj.getDate());
                                return '<div class="wf-col" style="--d:' + (i * 0.07).toFixed(2) + 's" title="' + d[0] + ', ' + acc + ' accepted, ' + rej + ' rejected, ' + accPct + '%">' +
                                    '<div class="wf-date">' + escapeHtml(dateLabel) + '</div>' +
                                    '<div class="wf-bars">' +
                                        '<div class="wf-seg a" style="height:' + Math.max(3, acc * scale) + 'px"></div>' +
                                        '<div class="wf-seg r" style="height:' + Math.max(3, rej * scale) + 'px"></div>' +
                                    '</div>' +
                                '</div>';
                            }).join('') + '</div>';
                        })()
                    },
                    suggest: {
                        title: 'Real notes, real replies.',
                        sub: 'Leave a suggestion below. I read every one and reply asap.',
                        visual: '<div class="paper"><div class="paper-title">Feedback</div><div class="paper-text">Every suggestion gets read and answered.</div></div>'
                    }
                };
                return states[tabId] || states.home;
            }

            function morphHero() {
                var hero = document.getElementById('hero');
                if (!hero || window._heroHasRendered) return;
                window._heroHasRendered = true;
                var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                if (prefersReduced) {
                    hero.style.opacity = '1';
                    return;
                }
                requestAnimationFrame(function() {
                    requestAnimationFrame(function() {
                        hero.style.opacity = '1';
                    });
                });
            }

            function animateHeroSwitch(tabId, rows) {
                var hero = document.getElementById('hero');
                if (!hero) return;
                if (hero._switchTimer) clearTimeout(hero._switchTimer);
                var state = buildHeroHTML(tabId, rows);
                hero.style.transition = 'opacity 0.18s ease';
                hero.style.opacity = '0.4';
                hero._switchTimer = setTimeout(function() {
                    hero._switchTimer = null;
                    hero.setAttribute('data-id', tabId);
                    hero.querySelector('.hero-title').innerHTML = state.title;
                    hero.querySelector('.hero-sub').textContent = state.sub;
                    hero.querySelector('.visual').innerHTML = state.visual;
                    hero.style.opacity = '1';
                }, 180);
            }

            var _searchDebounce = null;

            function wireTabListeners() {
                ensureScrollableFocusable();
                var activation = document.getElementById('activation-card');
                if (activation && activation.dataset.wired !== '1') {
                    activation.dataset.wired = '1';
                    activation.addEventListener('click', function(event) {
                        var action = event.target.closest('[data-activation-action]');
                        if (!action) return;
                        var kind = action.getAttribute('data-activation-action');
                        if (kind === 'email' || kind === 'telegram') { openAlertForm(kind); return; }
                        if (kind === 'search') {
                            var input = document.getElementById('home-search');
                            if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus({ preventScroll: true }); }
                            return;
                        }
                        if (kind === 'watch') {
                            if (currentUser) switchTab('watchlist');
                            else openAccountModal();
                        }
                    });
                }
                paintActivation();
                var homeSearchEl = document.getElementById('home-search');
                if (homeSearchEl) {
                    homeSearchEl.addEventListener('input', function(e) {
                        homeSearchTerm = e.target.value;
                        if (homeSearchTerm.trim()) markActivation('search');
                        var clearBtn = document.getElementById('home-search-clear');
                        if (clearBtn && !clearBtn.getAttribute('data-tu-state')) clearBtn.hidden = !homeSearchTerm.trim();
                        // Debounce so rapid typing coalesces into a single repaint.
                        if (_searchDebounce) clearTimeout(_searchDebounce);
                        _searchDebounce = setTimeout(function() {
                            _searchDebounce = null;
                            if (activeTab === 'home') paintHomeRows();
                            syncUrl('replace');
                        }, 150);
                    });
                    // A committed search (Enter or leaving the field) is kept in
                    // the "Recent:" chips below the search bar.
                    homeSearchEl.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            saveRecentSearch(homeSearchTerm);
                            refreshRecentChips();
                            if (homeSearchTerm.trim().length >= 6) trackConversion('application_search', 'home');
                        }
                    });
                    homeSearchEl.addEventListener('blur', function() {
                        saveRecentSearch(homeSearchTerm);
                        refreshRecentChips();
                    });
                    // Don't pop the keyboard on touch devices (env detector sets
                    // body[data-env="touch"]); desktop keeps the search focused.
                    if (activeTab === 'home' && document.body.dataset.env !== 'touch') {
                        homeSearchEl.focus();
                        homeSearchEl.setSelectionRange(homeSearchEl.value.length, homeSearchEl.value.length);
                    }
                }
                var dateFilterEl = document.getElementById('past-date-filter');
                if (dateFilterEl) dateFilterEl.addEventListener('change', function(e) {
                    pastDateFilter = e.target.value;
                    // Toggle .has-filter on the datefilter wrapper so the X clear
                    // button appears/disappears WITHOUT re-rendering the whole
                    // past layout (the button is always in the DOM, just hidden).
                    if (dateFilterEl.parentElement) {
                        dateFilterEl.parentElement.classList.toggle('has-filter', !!pastDateFilter);
                    }
                    if (activeTab === 'past') paintPastRows();
                    syncUrl('replace');
                });
                // The decision filter: one funnel for the same single choice the
                // table's pills would spell out, with the counts in the panel.
                var statusHost = document.getElementById('past-status-filter');
                if (statusHost && window.FilterDisclosure) {
                    var real = realRows(cache || []);
                    var sc = { all: real.length, accepted: 0, rejected: 0, pending: 0 };
                    real.forEach(function(r) {
                        var s = r._status || classify(r.decision);
                        if (sc[s] !== undefined) sc[s] += 1;
                    });
                    FilterDisclosure.mount(statusHost, {
                        label: 'Filter past decisions',
                        size: 'sm',
                        head: 'Decision',
                        showValue: true,
                        value: PAST_STATUSES.indexOf(pastStatusFilter) === -1 ? 'all' : pastStatusFilter,
                        defaultId: 'all',
                        choices: [
                            { id: 'all', label: 'All decisions', glyph: 'grid', hint: sc.all },
                            { id: 'accepted', label: 'Accepted', glyph: 'check', hint: sc.accepted },
                            { id: 'rejected', label: 'Rejected', glyph: 'x', hint: sc.rejected },
                            { id: 'pending', label: 'Pending', glyph: 'clock', hint: sc.pending }
                        ].filter(function(c) { return c.id === 'all' || c.hint > 0 || c.id === pastStatusFilter; }),
                        onChange: function(id) {
                            pastStatusFilter = id;
                            paintPastRows();
                            syncUrl('replace');
                        }
                    });
                }
                var dateClearEl = document.getElementById('past-date-clear');
                if (dateClearEl) dateClearEl.addEventListener('click', function() {
                    pastDateFilter = '';
                    if (dateClearEl.parentElement) {
                        dateClearEl.parentElement.classList.remove('has-filter');
                    }
                    if (activeTab === 'past') paintPastRows();
                    syncUrl('replace');
                });
                // Daily Summary drill-down: delegated handler survives re-renders;
                // clicking (or Enter/Space on) a day's date cell toggles the
                // detail row beneath it listing that day's applications.
                var dailyTbody = document.querySelector('#tab-body .daily-table tbody');
                if (dailyTbody) {
                    dailyTbody.onclick = function(e) {
                        var t = e.target && e.target.closest ? e.target.closest('.dd-toggle') : null;
                        if (!t) return;
                        var detail = t.closest('tr') && t.closest('tr').nextElementSibling;
                        if (detail && detail.classList.contains('dd-row')) toggleDayDetail(t, detail);
                    };
                    dailyTbody.onkeydown = function(e) {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        var t = e.target && e.target.closest ? e.target.closest('.dd-toggle') : null;
                        if (!t) return;
                        e.preventDefault();
                        var detail = t.closest('tr') && t.closest('tr').nextElementSibling;
                        if (detail && detail.classList.contains('dd-row')) toggleDayDetail(t, detail);
                    };
                }
                // Real <form> - intercept the submit event (covers the button
                // AND Enter-key submission) and POST via fetch, so the page
                // shows its own success card instead of navigating away.
                var suggForm = document.getElementById('sugg-form');
                if (suggForm) suggForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    submitSuggestion();
                });
                var timeForm = document.getElementById('time-form');
                if (timeForm) timeForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    submitTimeline(false);
                });
                var alertForm = document.getElementById('alert-form');
                if (alertForm) alertForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    submitAlert();
                });
                var tgBtn = document.getElementById('telegram-alert-btn');
                if (tgBtn) tgBtn.onclick = async function() {
                    var form = document.getElementById('alert-form');
                    var statusEl = document.getElementById('alert-status');
                    if (!form || !statusEl) return;
                    var appNumEl = form.querySelector('input[name="application_number"]');
                    var embassyEl = form.querySelector('select[name="embassy"]');
                    var appNum = (appNumEl && appNumEl.value ? appNumEl.value : '').trim();
                    var embassy = embassyEl && embassyEl.value ? embassyEl.value : '';
                    if (!/^\d{8}$/.test(appNum)) {
                        statusEl.textContent = 'Please enter a valid 8-digit application number.';
                        statusEl.style.color = 'var(--red)';
                        if (appNumEl) appNumEl.focus();
                        return;
                    }
                    tgBtn.disabled = true;
                    statusEl.textContent = 'Opening Telegram…';
                    statusEl.style.color = 'var(--ink)';
                    try {
                        var res = await fetch('/api/telegram/start', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ application_number: appNum, embassy: embassy })
                        });
                        var data = await res.json().catch(function() { return {}; });
                        if (res.ok && data.url) {
                            window.open(data.url, '_blank', 'noopener');
                            markActivation('alerts');
                            trackConversion('alert_telegram_opened', 'suggestions');
                            statusEl.textContent = 'Press Start in Telegram to finish linking ' + appNum + '.';
                            statusEl.style.color = 'var(--green)';
                        } else {
                            statusEl.textContent = '❌ ' + (data.error || 'Telegram alerts are not available yet.');
                            statusEl.style.color = 'var(--red)';
                        }
                    } catch (err) {
                        statusEl.textContent = '❌ Network error. Please try again.';
                        statusEl.style.color = 'var(--red)';
                    } finally {
                        tgBtn.disabled = false;
                    }
                };
                // Recent-search chips re-run the search they were saved from.
                var recentRow = document.getElementById('recent-searches');
                if (recentRow) recentRow.onclick = function(e) {
                    var chip = e.target && e.target.closest ? e.target.closest('.recent-chip') : null;
                    if (!chip) return;
                    homeSearchTerm = chip.getAttribute('data-q') || '';
                    var input = document.getElementById('home-search');
                    if (input) input.value = homeSearchTerm;
                    paintHomeRows();
                    syncUrl('replace');
                };
                // Watchlist add/remove (delegated - #watch-area is repainted
                // by paintWatch on every keystroke). Server-backed when signed in.
                wireHomeWatch();
                var watchArea = document.getElementById('watch-area');
                if (watchArea) watchArea.onclick = function(e) {
                    var add = e.target && e.target.closest ? e.target.closest('[data-watch-add]') : null;
                    var del = e.target && e.target.closest ? e.target.closest('[data-watch-del]') : null;
                    if (add) {
                        var list = getWatchlist();
                        var t = add.getAttribute('data-watch-add');
                        if (t && list.indexOf(t) === -1) { list.unshift(t); saveWatchlist(list); }
                        paintWatch();
                    } else if (del) {
                        var gone = del.getAttribute('data-watch-del');
                        saveWatchlist(getWatchlist().filter(function(t) { return t !== gone; }));
                        paintWatch();
                    }
                };
                // CSV export: Home exports the current search (or everything),
                // Past exports the filtered day (or everything).
                var homeExport = document.getElementById('home-export');
                if (homeExport) homeExport.addEventListener('click', function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    var file = 'visa-decisions-all.csv';
                    if (homeSearchTerm.trim()) {
                        var term = normalizeIRL(homeSearchTerm);
                        rows = rows.filter(function(r) { return normalizeIRL(r.irl).indexOf(term) !== -1; });
                        file = 'visa-search.csv';
                    }
                    exportCSV(rows, file);
                });
                
                // Excel export for Home tab
                var homeExportExcel = document.getElementById('home-export-excel');
                if (homeExportExcel) homeExportExcel.addEventListener('click', async function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    var file = 'visa-decisions-all.xlsx';
                    if (homeSearchTerm.trim()) {
                        var term = normalizeIRL(homeSearchTerm);
                        rows = rows.filter(function(r) { return normalizeIRL(r.irl).indexOf(term) !== -1; });
                        file = 'visa-search.xlsx';
                    }
                    await exportExcel(rows, file);
                });
                
                // PDF export for Home tab
                var homeExportPDF = document.getElementById('home-export-pdf');
                if (homeExportPDF) homeExportPDF.addEventListener('click', async function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    var file = 'visa-decisions-all.pdf';
                    if (homeSearchTerm.trim()) {
                        var term = normalizeIRL(homeSearchTerm);
                        rows = rows.filter(function(r) { return normalizeIRL(r.irl).indexOf(term) !== -1; });
                        file = 'visa-search.pdf';
                    }
                    await exportPDF(rows, file);
                });
                
                // Clear search is the home view's destructive control: the query
                // is dropped immediately and the button itself holds the window.
                // It lives in the toolbar, outside the table paint, so the click
                // that clears the search is still there to bring it back.
                var homeClear = document.getElementById('home-search-clear');
                var clearedSearch = null;
                if (homeClear && window.TimeUndo) {
                    TimeUndo.mount(homeClear, {
                        seconds: 6,
                        onStart: function() {
                            if (!homeSearchTerm.trim()) return false;
                            var input = document.getElementById('home-search');
                            clearedSearch = { term: homeSearchTerm, field: input ? input.value : homeSearchTerm };
                            homeClear.hidden = false;
                            homeSearchTerm = '';
                            if (input) input.value = '';
                            paintHomeRows();
                            syncUrl('replace');
                            return true;
                        },
                        onCancel: function() {
                            if (!clearedSearch) return;
                            homeSearchTerm = clearedSearch.term;
                            var input = document.getElementById('home-search');
                            if (input) input.value = clearedSearch.field;
                            clearedSearch = null;
                            paintHomeRows();
                            syncUrl('replace');
                        },
                        onCommit: function() {
                            clearedSearch = null;
                            var input = document.getElementById('home-search');
                            homeClear.hidden = !(input && input.value.trim());
                        }
                    });
                    if (!homeSearchTerm.trim()) homeClear.hidden = true;
                }
                var pastExport = document.getElementById('past-export');
                if (pastExport) pastExport.addEventListener('click', function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    if (pastDateFilter) {
                        rows = rows.filter(function(r) { return r.date === pastDateFilter; });
                    }
                    if (pastStatusFilter !== 'all') {
                        rows = rows.filter(function(r) { return (r._status || classify(r.decision)) === pastStatusFilter; });
                    }
                    var file = 'visa-decisions-' + (pastStatusFilter === 'all' ? '' : pastStatusFilter + '-')
                        + (pastDateFilter || 'all') + '.csv';
                    exportCSV(rows, file);
                });
                // Excel export for Past tab
                var pastExportExcel = document.getElementById('past-export-excel');
                if (pastExportExcel) pastExportExcel.addEventListener('click', async function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    if (pastDateFilter) rows = rows.filter(function(r) { return r.date === pastDateFilter; });
                    if (pastStatusFilter !== 'all') rows = rows.filter(function(r) { return (r._status || classify(r.decision)) === pastStatusFilter; });
                    var file = 'visa-decisions-' + (pastStatusFilter === 'all' ? '' : pastStatusFilter + '-') + (pastDateFilter || 'all') + '.xlsx';
                    await exportExcel(rows, file);
                });
                
                // PDF export for Past tab
                var pastExportPDF = document.getElementById('past-export-pdf');
                if (pastExportPDF) pastExportPDF.addEventListener('click', async function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    if (pastDateFilter) rows = rows.filter(function(r) { return r.date === pastDateFilter; });
                    if (pastStatusFilter !== 'all') rows = rows.filter(function(r) { return (r._status || classify(r.decision)) === pastStatusFilter; });
                    var file = 'visa-decisions-' + (pastStatusFilter === 'all' ? '' : pastStatusFilter + '-') + (pastDateFilter || 'all') + '.pdf';
                    await exportPDF(rows, file);
                });
                
                // Fill the health card when meta has loaded (no-op otherwise).
                renderMetaCard();
                // Stale-data banner: "Retry now" re-fetches and re-renders the
                // current tab in place; if the refresh fails again the banner
                // simply returns with the button re-enabled.
                var staleRetry = document.getElementById('stale-retry');
                if (staleRetry) staleRetry.addEventListener('click', function() {
                    staleRetry.disabled = true;
                    // "Retry now" -> "Retrying…" -> "Retry now". The kit is what
                    // cross-fades those two labels and travels between their
                    // widths; the direct write is the no-kit fallback.
                    if (window.DynamicButton) window.DynamicButton.say(staleRetry, 'Retrying\u2026');
                    else staleRetry.textContent = 'Retrying\u2026';
                    loadData({ force: true }).then(function() {
                        var body = document.getElementById('tab-body');
                        if (!body) return location.reload();
                        if (activeTab === 'home') body.innerHTML = renderHomeLayout(cache || []);
                        else if (activeTab === 'daily') body.innerHTML = renderDailySummary(cache || []);
                        else if (activeTab === 'past') body.innerHTML = renderPastLayout(cache || []);
                        else body.innerHTML = renderSuggestLayout();
                        wireTabListeners();
                        if (activeTab === 'home') paintHomeRows();
                        else if (activeTab === 'past') paintPastRows();
                        if (staleAt) {
                            staleRetry.disabled = false;
                            if (window.DynamicButton) window.DynamicButton.restore(staleRetry);
                            else staleRetry.textContent = 'Retry now';
                        }
                    });
                });
                var scrollBtn = document.getElementById('scroll-top-btn');
                if (scrollBtn) {
                    var onScroll = function() {
                        if (window.scrollY > 300) scrollBtn.classList.add('visible');
                        else scrollBtn.classList.remove('visible');
                    };
                    if (window._scrollTopHandler) window.removeEventListener('scroll', window._scrollTopHandler);
                    window._scrollTopHandler = onScroll;
                    window.addEventListener('scroll', onScroll, { passive: true });
                    onScroll();
                    scrollBtn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });
                }
            }

            async function switchTab(tabId, opts) {
                if (!document.getElementById('hero')) return;
                activeTab = tabId;
                if (!(opts && opts.noUrl)) syncUrl('push');
                var pills = document.querySelectorAll('#visa-dash .navpill');
                for (var i = 0; i < pills.length; i++) {
                    pills[i].classList.toggle('active', pills[i].getAttribute('data-tab') === tabId);
                }
                // Use cached data to avoid stutter
                var rows = cache && cache.length ? cache : await loadData();
                animateHeroSwitch(tabId, rows);
                var tabBody = document.getElementById('tab-body');
                if (!tabBody) return;
                if (tabId === 'home') tabBody.innerHTML = renderHomeLayout(rows);
                else if (tabId === 'daily') tabBody.innerHTML = renderDailySummary(rows);
                else if (tabId === 'past') tabBody.innerHTML = renderPastLayout(rows);
                else if (tabId === 'analytics') tabBody.innerHTML = renderAnalyticsLayout(rows);
                else if (tabId === 'watchlist') { tabBody.innerHTML = renderWatchlistLayout(rows); wireWatchAdd(); wireWatchBulk(); }
                else if (tabId === 'checklist') { tabBody.innerHTML = renderChecklistLayout(); wireChecklistForm(); }
                else if (tabId === 'search') { tabBody.innerHTML = renderSearchLayout(); wireSearchForm(); wireVFSTracking(); }
                else { tabBody.innerHTML = renderSuggestLayout(); }
                wireTabListeners();
                // Paint deferred row content after the layout is in the DOM.
                if (tabId === 'home') paintHomeRows();
                else if (tabId === 'past') paintPastRows();
                else if (tabId === 'analytics') paintAnalyticsCharts();
                else if (tabId === 'watchlist') paintWatchlist();
                // Stamp "last visited" once per page load (guarded inside).
                markVisited();
            }


            // ====== CHECKLIST TAB ======
            function renderChecklistLayout() {
                return '<div class="checklist-layout">' +
                    '<h2 class="checklist-title">Document Checklist Generator</h2>' +
                    '<p class="checklist-sub">Generate a personalized document checklist for your Irish visa application.</p>' +
                    '<form id="checklist-form" class="checklist-form" novalidate>' +
                    '<div class="checklist-field"><label for="cl-visa-type">Visa type <span class="required">*</span></label>' +
                    '<select id="cl-visa-type" name="visa_type" required>' +
                    '<option value="">Select visa type&hellip;</option>' +
                    '<option value="study">Study</option>' +
                    '<option value="work">Work</option>' +
                    '<option value="visit">Visit</option>' +
                    '<option value="family">Family</option>' +
                    '<option value="transit">Transit</option>' +
                    '<option value="research">Research</option>' +
                    '</select></div>' +
                    '<div class="checklist-field"><label for="cl-embassy">Visa office <span class="required">*</span></label>' +
                    '<select id="cl-embassy" name="embassy" required>' +
                    '<option value="new-delhi">New Delhi</option>' +
                    '<option value="beijing">Beijing</option>' +
                    '<option value="dublin">Dublin</option>' +
                    '<option value="abu-dhabi">Abu Dhabi</option>' +
                    '<option value="abuja">Abuja</option>' +
                    '<option value="ankara">Ankara</option>' +
                    '</select></div>' +
                    '<div class="checklist-field"><label for="cl-age">Applicant age</label>' +
                    '<input type="number" id="cl-age" name="age" min="0" max="120" placeholder="e.g. 25"></div>' +
                    '<div class="checklist-field"><label for="cl-nationality">Nationality</label>' +
                    '<input type="text" id="cl-nationality" name="nationality" placeholder="e.g. India"></div>' +
                    '<div class="checklist-field"><label for="cl-duration">Intended stay (months)</label>' +
                    '<input type="number" id="cl-duration" name="duration_months" min="1" max="120" placeholder="e.g. 24"></div>' +
                    '<div class="checklist-field"><label for="cl-permit-type">Work permit type (if work visa)</label>' +
                    '<select id="cl-permit-type" name="permit_type">' +
                    '<option value="">Not applicable</option>' +
                    '<option value="critical_skills">Critical Skills</option>' +
                    '<option value="general">General</option>' +
                    '<option value="intra_company">Intra-company transfer</option>' +
                    '<option value="contractor">Contractor</option>' +
                    '<option value="sport_cultural">Sport/Cultural</option>' +
                    '</select></div>' +
                    '<div class="checklist-field"><label for="cl-regulated">Regulated profession?</label>' +
                    '<select id="cl-regulated" name="regulated_profession">' +
                    '<option value="">No</option>' +
                    '<option value="true">Yes</option>' +
                    '</select></div>' +
                    '<button class="btn" type="submit" id="checklist-submit">Generate Checklist</button>' +
                    '<div class="note" id="checklist-status" aria-live="polite"></div>' +
                    '</form>' +
                    '<div id="checklist-result" class="checklist-result" hidden></div>' +
                    '</div>';
            }

            function wireChecklistForm() {
                var form = document.getElementById('checklist-form');
                if (!form) return;
                form.addEventListener('submit', async function(e) {
                    e.preventDefault();
                    var btn = document.getElementById('checklist-submit');
                    var status = document.getElementById('checklist-status');
                    var resultDiv = document.getElementById('checklist-result');
                    btn.disabled = true;
                    status.textContent = 'Generating checklist\u2026';
                    status.style.color = 'var(--ink)';
                    var fd = new FormData(form);
                    var body = {};
                    for (var pair of fd) { if (pair[1]) body[pair[0]] = pair[1]; }
                    try {
                        var res = await fetch('/api/checklist', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        });
                        var data = await res.json();
                        if (res.ok) {
                            renderChecklistResult(data, resultDiv);
                            status.textContent = 'Checklist generated.';
                            status.style.color = 'var(--green)';
                        } else {
                            status.textContent = data.error || 'Failed to generate checklist.';
                            status.style.color = 'var(--red)';
                        }
                    } catch (err) {
                        status.textContent = 'Network error. Please try again.';
                        status.style.color = 'var(--red)';
                    } finally {
                        btn.disabled = false;
                    }
                });
            }

            function renderChecklistResult(data, container) {
                container.hidden = false;
                var html = '<h3>Your Document Checklist</h3>';
                if (data.checklist && Array.isArray(data.checklist)) {
                    html += '<ul class="checklist-items">';
                    data.checklist.forEach(function(item) {
                        var required = item.required ? ' <span class="badge required">Required</span>' : '';
                        var category = item.category ? ' <span class="badge category">' + escapeHtml(item.category) + '</span>' : '';
                        html += '<li><strong>' + escapeHtml(item.name) + '</strong>' + required + category + '</li>';
                    });
                    html += '</ul>';
                } else if (data.items && Array.isArray(data.items)) {
                    html += '<ul class="checklist-items">';
                    data.items.forEach(function(item) {
                        var required = item.required ? ' <span class="badge required">Required</span>' : '';
                        var category = item.category ? ' <span class="badge category">' + escapeHtml(item.category) + '</span>' : '';
                        html += '<li><strong>' + escapeHtml(item.name) + '</strong>' + required + category + '</li>';
                    });
                    html += '</ul>';
                } else {
                    html += '<p class="note2">No specific checklist items returned. See full API response below.</p>';
                    html += '<pre class="api-response">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
                }
                container.innerHTML = html;
            }


            // ====== SEARCH TAB ======
            function renderSearchLayout() {
                return '<div class="search-layout">' +
                    '<h2 class="search-title">Advanced Search</h2>' +
                    '<p class="search-sub">Search visa decisions with fuzzy matching, filters, and saved searches.</p>' +
                    '<form id="search-form" class="search-form" novalidate>' +
                    '<div class="search-field"><label for="search-query">Search query</label>' +
                    '<input type="text" id="search-query" name="query" placeholder="e.g. study visa, IRL2026123456, etc."></div>' +
                    '<div class="search-row">' +
                    '<div class="search-field"><label for="search-mode">Mode</label>' +
                    '<select id="search-mode" name="mode">' +
                    '<option value="hybrid">Hybrid (fuzzy + nearest)</option>' +
                    '<option value="fuzzy">Fuzzy match</option>' +
                    '<option value="nearest">Nearest neighbor</option>' +
                    '<option value="filter">Filter only</option>' +
                    '</select></div>' +
                    '<div class="search-field"><label for="search-embassy">Visa office</label>' +
                    '<select id="search-embassy" name="embassy">' +
                    '<option value="">All offices</option>' +
                    '<option value="new-delhi">New Delhi</option>' +
                    '<option value="beijing">Beijing</option>' +
                    '<option value="dublin">Dublin</option>' +
                    '<option value="abu-dhabi">Abu Dhabi</option>' +
                    '<option value="abuja">Abuja</option>' +
                    '<option value="ankara">Ankara</option>' +
                    '</select></div>' +
                    '<div class="search-field"><label for="search-decision">Decision</label>' +
                    '<select id="search-decision" name="decision">' +
                    '<option value="">Any</option>' +
                    '<option value="Approved">Approved</option>' +
                    '<option value="Refused">Refused</option>' +
                    '<option value="Pending">Pending</option>' +
                    '</select></div>' +
                    '<div class="search-field"><label for="search-limit">Results per page</label>' +
                    '<select id="search-limit" name="limit">' +
                    '<option value="20">20</option>' +
                    '<option value="50">50</option>' +
                    '<option value="100">100</option>' +
                    '</select></div>' +
                    '</div>' +
                    '<div class="search-row">' +
                    '<div class="search-field"><label for="search-sort">Sort by</label>' +
                    '<select id="search-sort" name="sort">' +
                    '<option value="date_desc">Date (newest first)</option>' +
                    '<option value="date_asc">Date (oldest first)</option>' +
                    '<option value="number_desc">Application number (desc)</option>' +
                    '<option value="number_asc">Application number (asc)</option>' +
                    '</select></div>' +
                    '<div class="search-field"><label for="search-date-from">Decisions from</label>' +
                    '<input type="date" id="search-date-from" name="date_from"></div>' +
                    '<div class="search-field"><label for="search-date-to">Decisions to</label>' +
                    '<input type="date" id="search-date-to" name="date_to"></div>' +
                    '</div>' +
                    '<div class="search-actions">' +
                    '<button class="btn" type="submit" id="search-submit">Search</button>' +
                    '<button type="button" class="btn secondary" id="search-save">Save Search</button>' +
                    '</div>' +
                    '<div class="note" id="search-status" aria-live="polite"></div>' +
                    '</div>' +
                    '</form>' +
                    renderVFSTracking() +
                    '<div id="search-results" class="search-results"></div>' +
                    '<div id="search-saved" class="search-saved" hidden></div>' +
                    '</div>';
            }

            function wireSearchForm() {
                var form = document.getElementById('search-form');
                if (!form) return;
                form.addEventListener('submit', async function(e) {
                    e.preventDefault();
                    var btn = document.getElementById('search-submit');
                    var status = document.getElementById('search-status');
                    var resultsDiv = document.getElementById('search-results');
                    btn.disabled = true;
                    status.textContent = 'Searching\u2026';
                    status.style.color = 'var(--ink)';
                    var fd = new FormData(form);
                    var body = {};
                    for (var pair of fd) { if (pair[1]) body[pair[0]] = pair[1]; }
                    try {
                        var res = await fetch('/api/search', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        });
                        var data = await res.json();
                        if (res.ok && data.success) {
                            renderSearchResults(data, resultsDiv);
                            status.textContent = data.results.length + ' result' + (data.results.length === 1 ? '' : 's') + ' found.';
                            status.style.color = 'var(--green)';
                        } else {
                            status.textContent = data.error || 'Search failed.';
                            status.style.color = 'var(--red)';
                        }
                    } catch (err) {
                        status.textContent = 'Network error. Please try again.';
                        status.style.color = 'var(--red)';
                    } finally {
                        btn.disabled = false;
                    }
                });

                // Save search button
                var saveBtn = document.getElementById('search-save');
                if (saveBtn) {
                    saveBtn.addEventListener('click', async function() {
                        var fd = new FormData(form);
                        var body = {};
                        for (var pair of fd) { if (pair[1]) body[pair[0]] = pair[1]; }
                        var name = prompt('Enter a name for this saved search:');
                        if (!name) return;
                        body.save_search = true;
                        body.search_name = name;
                        try {
                            var res = await fetch('/api/search', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body)
                            });
                            var data = await res.json();
                            if (res.ok && data.saved_search_id) {
                                alert('Search saved!');
                            } else {
                                alert('Failed to save: ' + (data.error || 'unknown error'));
                            }
                        } catch (err) {
                            alert('Network error.');
                        }
                    });
                }

                // Load saved searches on tab enter
                loadSavedSearches();
            }

            async function loadSavedSearches() {
                try {
                    var res = await fetch('/api/search?action=list', { method: 'GET', credentials: 'include' });
                    var data = await res.json();
                    var searches = (data && (data.searches || data.saved_searches)) || [];
                    var container = document.getElementById('search-saved');
                    if (!container) return;
                    if (!res.ok || !searches.length) {
                        container.hidden = true;
                        container.innerHTML = '';
                        return;
                    }
                    container.hidden = false;
                    var html = '<h3>Saved Searches</h3><ul class="saved-searches">';
                    searches.forEach(function(s) {
                        var query = s.query || (s.params && s.params.query) || 'Saved search';
                        html += '<li class="saved-search-row"><button type="button" class="saved-search-btn" data-id="' + s.id + '">' +
                            escapeHtml(s.name) + ' <span class="note2">(' + escapeHtml(query) + ')</span></button>' +
                            '<button type="button" class="saved-search-delete" data-id="' + s.id + '" aria-label="Delete saved search ' + escapeHtml(s.name) + '">Delete</button></li>';
                    });
                    html += '</ul>';
                    container.innerHTML = html;
                    container.querySelectorAll('.saved-search-btn').forEach(function(btn) {
                        btn.addEventListener('click', function() {
                            loadSavedSearch(btn.getAttribute('data-id'));
                        });
                    });
                    container.querySelectorAll('.saved-search-delete').forEach(function(btn) {
                        btn.addEventListener('click', function() {
                            deleteSavedSearch(btn.getAttribute('data-id'));
                        });
                    });
                } catch (e) { /* ignore */ }
            }

            async function deleteSavedSearch(id) {
                if (!id || !confirm('Delete this saved search?')) return;
                try {
                    var res = await fetch('/api/search?id=' + encodeURIComponent(id), { method: 'DELETE', credentials: 'include' });
                    if (!res.ok) throw new Error('delete failed');
                    await loadSavedSearches();
                } catch (e) {
                    alert('Could not delete that saved search.');
                }
            }

            async function loadSavedSearch(id) {
                try {
                    var res = await fetch('/api/search?action=get&id=' + encodeURIComponent(id), { method: 'GET', credentials: 'include' });
                    var data = await res.json();
                    var saved = data && data.search;
                    if (!res.ok || !saved) return;
                    var params = saved.params;
                    if (typeof params === 'string') {
                        try { params = JSON.parse(params); } catch (e) { params = {}; }
                    }
                    if (!params || typeof params !== 'object') params = {};
                    var values = {};
                    var filters = params.filters && typeof params.filters === 'object' ? params.filters : {};
                    Object.keys(filters).forEach(function(key) { values[key] = filters[key]; });
                    Object.keys(params).forEach(function(key) { if (key !== 'filters') values[key] = params[key]; });
                    var form = document.getElementById('search-form');
                    if (!form) return;
                    Object.keys(values).forEach(function(key) {
                        if (form.elements[key] && values[key] !== null && values[key] !== undefined) {
                            form.elements[key].value = values[key];
                        }
                    });
                    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                } catch (e) { /* ignore */ }
            }

            function renderSearchResults(data, container) {
                container.innerHTML = '';
                if (!data.results || !data.results.length) {
                    container.innerHTML = '<p class="note2">No results found.</p>';
                    return;
                }
                var html = '<div class="search-results-header">' +
                    '<strong>' + data.results.length + '</strong> of <strong>' + data.pagination.total + '</strong> results' +
                    '</div>';
                html += '<div class="search-results-table"><table class="results-table"><thead>' +
                    '<tr><th>Decision date</th><th>Application No.</th><th>Decision</th><th>Office</th><th>Office report</th></tr></thead><tbody>';
                var officeNames = {
                    'new-delhi': 'New Delhi',
                    'beijing': 'Beijing',
                    'dublin': 'Dublin',
                    'abu-dhabi': 'Abu Dhabi',
                    'abuja': 'Abuja',
                    'ankara': 'Ankara'
                };
                data.results.forEach(function(r) {
                    var pillClass = r.decision === 'Approved' ? 'green' : r.decision === 'Refused' ? 'red' : 'amber';
                    var office = officeNames[r.embassy] || r.embassy || '';
                    html += '<tr>' +
                        '<td class="mono">' + escapeHtml(r.date || '') + '</td>' +
                        '<td class="mono">' + escapeHtml(r.number || r.irl || '') + '</td>' +
                        '<td><span class="pill ' + pillClass + '">' + escapeHtml(r.decision || '') + '</span></td>' +
                        '<td>' + escapeHtml(office) + '</td>' +
                        '<td class="mono">' + escapeHtml(r.report_date || '—') + '</td>' +
                        '</tr>';
                });
                html += '</tbody></table></div>' +
                    '<p class="note2 search-report-note">Office report is the latest published report date from that office; decision date is the date of the individual decision.</p>';
                if (data.pagination.has_more) {
                    html += '<div class="search-pagination"><button type="button" class="btn" id="search-load-more">Load more</button></div>';
                }
                container.innerHTML = html;
                var loadMore = document.getElementById('search-load-more');
                if (loadMore) {
                    loadMore.addEventListener('click', function() {
                        var form = document.getElementById('search-form');
                        var fd = new FormData(form);
                        var body = {};
                        for (var pair of fd) { if (pair[1]) body[pair[0]] = pair[1]; }
                        body.offset = data.pagination.offset + data.pagination.limit;
                        // Re-search with new offset
                        fetch('/api/search', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        }).then(function(r) { return r.json(); }).then(function(newData) {
                            if (newData.success) {
                                data.pagination = newData.pagination;
                                data.results = data.results.concat(newData.results);
                                renderSearchResults(data, container);
                            }
                        });
                    });
                }
            }


            // ====== VFS TRACKING ======
            function renderVFSTracking() {
                return '<div class="vfs-tracking">' +
                    '<h3>VFS Global appointment check</h3>' +
                    '<p class="note2">Track an application, or check the official booking page for the selected VAC. VFS shows the real calendar only after sign-in, so this tool never claims a slot it cannot see.</p>' +
                    '<form id="vfs-track-form" class="vfs-track-form" novalidate>' +
                    '<div class="vfs-field"><label for="vfs-ref">Reference Number <span class="required">*</span></label>' +
                    '<input type="text" id="vfs-ref" name="reference" required placeholder="e.g. IN1234567890" pattern="[A-Z]{2}\\d{10}"></div>' +
                    '<div class="vfs-field"><label for="vfs-lname">Last Name <span class="required">*</span></label>' +
                    '<input type="text" id="vfs-lname" name="last_name" required placeholder="Your surname"></div>' +
                    '<div class="vfs-field"><label for="vfs-vac">VAC Location</label>' +
                    '<select id="vfs-vac" name="vac">' +
                    '<option value="new-delhi">New Delhi</option>' +
                    '<option value="mumbai">Mumbai</option>' +
                    '<option value="chennai">Chennai</option>' +
                    '<option value="kolkata">Kolkata</option>' +
                    '<option value="bangalore">Bangalore</option>' +
                    '<option value="hyderabad">Hyderabad</option>' +
                    '<option value="pune">Pune</option>' +
                    '<option value="ahmedabad">Ahmedabad</option>' +
                    '<option value="jalandhar">Jalandhar</option>' +
                    '<option value="chandigarh">Chandigarh</option>' +
                    '<option value="cochin">Cochin</option>' +
                    '</select></div>' +
                    '<div class="vfs-actions" style="display:flex;gap:8px;flex-wrap:wrap">' +
                    '<button class="btn" type="submit">Track on VFS Global</button>' +
                    '<button class="btn secondary" type="button" id="vfs-check-btn">Check official VFS page</button>' +
                    '</div>' +
                    '</form>' +
                    '<div id="vfs-result" class="vfs-result" hidden></div>' +
                    '<div id="vfs-appointment-result" class="vfs-result" aria-live="polite" hidden></div>' +
                    '<p class="note2">VFS does not publish Ireland-India appointment slots publicly. This check reports the page state and points you to the official sign-in; it cannot hold or confirm a slot.</p>' +
                    '</div>';
            }

            function wireVFSTracking() {
                var form = document.getElementById('vfs-track-form');
                if (!form) return;
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    var ref = document.getElementById('vfs-ref').value.trim();
                    var lname = document.getElementById('vfs-lname').value.trim();
                    if (!ref || !lname) return;
                    var url = 'https://visa.vfsglobal.com/ind/en/irl/track-application' +
                        '?reference=' + encodeURIComponent(ref) +
                        '&lastName=' + encodeURIComponent(lname);
                    window.open(url, '_blank', 'noopener,noreferrer');
                });
                var check = document.getElementById('vfs-check-btn');
                if (!check) return;
                check.addEventListener('click', async function() {
                    var out = document.getElementById('vfs-appointment-result');
                    var vac = document.getElementById('vfs-vac').value;
                    if (!out) return;
                    out.hidden = false;
                    out.textContent = 'Checking the official VFS booking page\u2026';
                    check.disabled = true;
                    try {
                        var response = await fetch('/api/vfs/appointments?office=' + encodeURIComponent(vac), {
                            headers: { Accept: 'application/json' }
                        });
                        var data = await response.json();
                        if (!response.ok) throw new Error(data.error || 'Could not check VFS');
                        var labels = {
                            available: 'Booking-calendar language found',
                            unavailable: 'No appointments reported',
                            login_required: 'VFS sign-in required',
                            maintenance: 'VFS maintenance',
                            challenge: 'VFS bot challenge',
                            unknown: 'Availability unknown'
                        };
                        var label = labels[data.availability] || 'Availability unknown';
                        var actionUrl = data.requires_login ? (data.login_url || data.booking_url) : data.booking_url;
                        var actionLabel = data.requires_login ? 'Sign in to the official VFS portal' : 'Open official VFS booking page';
                        var checkedAt = data.checked_at ? new Date(data.checked_at).toLocaleString() : 'just now';
                        out.innerHTML = '<strong>' + escapeHtml(label) + '</strong> \u00b7 ' + escapeHtml(data.office_name || vac) +
                            '<div class="note2" style="margin-top:6px">' + escapeHtml(data.message || '') + '</div>' +
                            '<div class="note2" style="margin-top:6px">Checked ' + escapeHtml(checkedAt) +
                            ' \u00b7 confidence: ' + escapeHtml(data.confidence || 'none') +
                            ' \u00b7 source: ' + escapeHtml(data.source || 'http') + '</div>' +
                            '<p style="margin:10px 0 0"><a class="link-btn" href="' + escapeHtml(actionUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(actionLabel) + '</a></p>' +
                            '<p class="note2" style="margin:8px 0 0">' + escapeHtml(data.disclaimer || '') + '</p>';
                    } catch (error) {
                        out.innerHTML = '<strong>Could not check availability.</strong><div class="note2" style="margin-top:6px">' + escapeHtml(error.message) + '</div>';
                    } finally {
                        check.disabled = false;
                    }
                });
            }

            // ====== WATCHLIST TAB ======
            function renderWatchlistLayout(rows) {
                var addForm =
                    '<div class="watch-card">' +
                    '<h3 class="watch-h3">Watch an application</h3>' +
                    '<form id="watch-add-form" novalidate>' +
                    '<div class="watch-field"><label>Application number</label>' +
                    '<input type="text" name="application_number" required inputmode="numeric" ' +
                    'autocomplete="off" maxlength="20" placeholder="e.g. IRL2026123456"></div>' +
                    '<div class="watch-field"><label>Visa office</label>' +
                    '<select name="embassy_slug">' +
                    '<option value="new-delhi">New Delhi</option>' +
                    '<option value="beijing">Beijing</option>' +
                    '<option value="dublin">Dublin</option>' +
                    '<option value="abu-dhabi">Abu Dhabi</option>' +
                    '<option value="abuja">Abuja</option>' +
                    '<option value="ankara">Ankara</option>' +
                    '</select></div>' +
                    '<div class="watch-field"><label>Nickname <span class="note2">(optional)</span></label>' +
                    '<input type="text" name="nickname" placeholder="e.g. My study visa"></div>' +
                    '<button class="btn" type="submit" id="watch-add-btn">Add to watchlist</button>' +
                    '<div class="note" id="watch-add-status" aria-live="polite"></div>' +
                    '</form>' +
                    '</div>';
                var listBox = currentUser
                    ? '<div id="watch-server-list" class="watch-card"><h3 class="watch-h3">Your watchlist</h3>' +
                      '<div class="note2" id="watch-server-status">Loading\u2026</div>' +
                      '<div id="watch-server-rows"></div></div>'
                    : '<div class="watch-card"><h3 class="watch-h3">Sign in to sync your watchlist</h3>' +
                      '<p class="note2">Create an account or sign in to keep your watched applications ' +
                      'across devices and receive email/push alerts when a decision is published.</p></div>';
                var bulkBox = currentUser
                    ? '<div class="watch-card"><h3 class="watch-h3">Bulk add (agency / family)</h3>' +
                      '<p class="note2">Paste up to 50 application numbers, one per line. They are added to the office selected here.</p>' +
                      '<form id="watch-bulk-form" novalidate>' +
                      '<div class="watch-field"><label>Application numbers</label>' +
                      '<textarea name="numbers" rows="4" placeholder="48850812&#10;63690452"></textarea></div>' +
                      '<div class="watch-field"><label>Visa office</label><select name="embassy_slug">' +
                      '<option value="new-delhi">New Delhi</option><option value="beijing">Beijing</option>' +
                      '<option value="dublin">Dublin</option><option value="abu-dhabi">Abu Dhabi</option>' +
                      '<option value="abuja">Abuja</option><option value="ankara">Ankara</option>' +
                      '</select></div>' +
                      '<button class="btn" type="submit" id="watch-bulk-btn">Add all</button>' +
                      '<div class="note" id="watch-bulk-status" aria-live="polite"></div>' +
                      '</form></div>' +
                      '<div class="watch-card"><h3 class="watch-h3">Your data</h3>' +
                      '<p class="note2">Download a JSON copy of your account, watchlist and alert subscriptions.</p>' +
                      '<button type="button" class="export-btn tu-btn" id="watch-export-btn">Export my data</button></div>'
                    : '';
                return addForm + listBox + bulkBox;
            }

            async function paintWatchlist() {
                if (!currentUser) return;
                var rows = cache || [];
                var box = document.getElementById('watch-server-rows');
                var status = document.getElementById('watch-server-status');
                if (!box) return;
                try {
                    var wl = await fetchWatchlist();
                    if (status) status.textContent = wl.length
                        ? wl.length + ' watched application' + (wl.length === 1 ? '' : 's')
                        : 'Your watchlist is empty.';
                    box.innerHTML = '';
                    if (!wl.length) {
                        box.innerHTML = '<div class="note2">No watched applications yet. Add one above.</div>';
                        return;
                    }
                    // Resolve the latest decision for each watched number from local data.
                    var byIrl = {};
                    (rows || []).forEach(function(r) {
                        if (!r._placeholder && r.irl) byIrl[r.irl] = r;
                    });
                    var html = '<table class="results-table"><thead><tr>' +
                        '<th scope="col">Application</th><th scope="col">Office</th>' +
                        '<th scope="col">Nickname</th><th scope="col">Latest decision</th>' +
                        '<th scope="col">Date</th><th scope="col">Channels</th><th scope="col">&nbsp;</th>' +
                        '</tr></thead><tbody>';
                    wl.forEach(function(w) {
                        var r = byIrl[w.application_number];
                        var decision = r ? escapeHtml(r.decision || '-') : '\u2014';
                        var date = r ? escapeHtml(r.date) : '\u2014';
                        var pill = r ? ('<span class="pill ' + (r._pillClass || 'amber') + '">' + decision + '</span>') : decision;
                        var channelControls = [
                            ['email', 'Email', w.notify_email],
                            ['push', 'Push', w.notify_push]
                        ].map(function(item) {
                            return '<label class="watch-channel"><input type="checkbox" data-watch-id="' +
                                escapeHtml(w.id) + '" data-watch-field="notify_' + item[0] + '"' +
                                (item[2] ? ' checked' : '') + '> ' + item[1] + '</label>';
                        }).join('');
                        html += '<tr>' +
                            '<td class="mono">' + escapeHtml(w.application_number) + '</td>' +
                            '<td>' + escapeHtml(w.embassy_slug || 'new-delhi') + '</td>' +
                            '<td>' + escapeHtml(w.nickname || '\u2014') + '</td>' +
                            '<td>' + pill + '</td>' +
                            '<td>' + date + '</td>' +
                            '<td class="watch-channel-cell">' + channelControls + '</td>' +
                            '<td><button type="button" class="export-btn tu-btn" data-watch-push="' +
                            escapeHtml(w.application_number) + '" data-watch-office="' + escapeHtml(w.embassy_slug || 'new-delhi') +
                            '" title="Enable browser notifications" aria-label="Enable browser notifications for ' +
                            escapeHtml(w.application_number) + '">Enable push</button> ' +
                            '<button type="button" class="export-btn tu-btn" data-watch-remove="' +
                            escapeHtml(w.id) + '" title="Remove">Remove</button></td>' +
                            '</tr>';
                    });
                    box.innerHTML = html + '</tbody></table>';
                } catch (e) {
                    if (status) status.textContent = 'Could not load watchlist.';
                    box.innerHTML = '';
                }
                // Persist per-application email and push switches.
                box.onchange = function(e) {
                    var input = e.target && e.target.closest ? e.target.closest('[data-watch-field]') : null;
                    if (!input) return;
                    var id = input.getAttribute('data-watch-id');
                    var field = input.getAttribute('data-watch-field');
                    var value = input.checked;
                    var status = document.getElementById('watch-server-status');
                    input.disabled = true;
                    var patch = {};
                    patch[field] = value;
                    fetch('/api/user/watchlist/' + encodeURIComponent(id), {
                        method: 'PATCH',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch)
                    }).then(function(res) {
                        if (!res.ok) throw new Error('Could not update alert settings');
                        if (status) status.textContent = 'Alert settings updated.';
                    }).catch(function() {
                        input.checked = !value;
                        if (status) status.textContent = 'Could not update alert settings.';
                    }).finally(function() {
                        input.disabled = false;
                    });
                };
                // Delegate push and remove clicks.
                box.onclick = function(e) {
                    var pushBtn = e.target && e.target.closest ? e.target.closest('[data-watch-push]') : null;
                    if (pushBtn) {
                        var app = pushBtn.getAttribute('data-watch-push');
                        var office = pushBtn.getAttribute('data-watch-office');
                        var status = document.getElementById('watch-server-status');
                        pushBtn.disabled = true;
                        if (status) status.textContent = 'Requesting notification permission\u2026';
                        window.enablePushNotifications(app, office).then(function(result) {
                            if (status) status.textContent = result.ok
                                ? 'Browser notifications enabled for ' + app + '.'
                                : (result.error || 'Could not enable notifications.');
                        }).finally(function() { pushBtn.disabled = false; });
                        return;
                    }
                    var btn = e.target && e.target.closest ? e.target.closest('[data-watch-remove]') : null;
                    if (!btn) return;
                    var id = btn.getAttribute('data-watch-remove');
                    removeFromServerWatchlist(id).then(function(ok) {
                        if (ok) paintWatchlist();
                    });
                };
            }

            // Home "Watch" button: server-backed when signed in, localStorage
            // fallback for anonymous users. Replaces the local-only add so a
            // signed-in user's watchlist persists across devices.
            var _homeWatchWired = false;
            function wireHomeWatch() {
                if (_homeWatchWired) return;
                _homeWatchWired = true;
                var area = document.getElementById('watch-area');
                if (!area) return;
                area.onclick = function(e) {
                    var add = e.target && e.target.closest ? e.target.closest('[data-watch-add]') : null;
                    var del = e.target && e.target.closest ? e.target.closest('[data-watch-del]') : null;
                    if (add) {
                        var term = add.getAttribute('data-watch-add');
                        if (!term) return;
                        if (currentUser) {
                            addToServerWatchlist(term, 'new-delhi', null).then(function(ok) {
                                if (ok) {
                                    var list = getWatchlist();
                                    if (list.indexOf(term) === -1) { list.unshift(term); saveWatchlist(list); }
                                    markActivation('watch');
                                    trackConversion('watchlist_added', 'home-watch');
                                    paintWatch();
                                }
                            });
                        } else {
                            var list = getWatchlist();
                            if (list.indexOf(term) === -1) { list.unshift(term); saveWatchlist(list); }
                            markActivation('watch');
                            trackConversion('watchlist_added', 'home-watch-anonymous');
                            paintWatch();
                        }
                    } else if (del) {
                        var gone = del.getAttribute('data-watch-del');
                        saveWatchlist(getWatchlist().filter(function(t) { return t !== gone; }));
                        paintWatch();
                    }
                };
            }

            // Watch add form on the watchlist tab.
            function wireWatchAdd() {
                var form = document.getElementById('watch-add-form');
                if (!form || form.dataset.wired === '1') return;
                form.dataset.wired = '1';
                form.addEventListener('submit', async function(e) {
                    e.preventDefault();
                    var btn = document.getElementById('watch-add-btn');
                    var status = document.getElementById('watch-add-status');
                    var appNum = form.elements['application_number'].value.trim();
                    var embassy = form.elements['embassy_slug'].value;
                    var nickname = form.elements['nickname'].value.trim();
                    if (!appNum) return;
                    btn.disabled = true;
                    status.textContent = 'Adding\u2026';
                    try {
                        var ok = await addToServerWatchlist(appNum, embassy, nickname);
                        if (ok) {
                            status.textContent = 'Added to your watchlist.';
                            status.style.color = 'var(--green)';
                            form.reset();
                            markActivation('watch');
                            trackConversion('watchlist_added', 'watchlist');
                            paintWatchlist();
                        } else {
                            status.textContent = 'Could not add. Are you signed in?';
                            status.style.color = 'var(--red)';
                        }
                    } catch (err) {
                        status.textContent = 'Error adding watch.';
                        status.style.color = 'var(--red)';
                    } finally {
                        btn.disabled = false;
                    }
                });
            }

            function wireWatchBulk() {
                var form = document.getElementById('watch-bulk-form');
                if (form && form.dataset.wired !== '1') {
                    form.dataset.wired = '1';
                    form.addEventListener('submit', async function(e) {
                        e.preventDefault();
                        var status = document.getElementById('watch-bulk-status');
                        var btn = document.getElementById('watch-bulk-btn');
                        var raw = form.elements['numbers'].value || '';
                        var numbers = raw.split(/[\s,;]+/).map(function(v) { return v.trim().toUpperCase(); })
                            .filter(function(v) { return v.length > 0; });
                        numbers = numbers.filter(function(v, i, arr) { return arr.indexOf(v) === i; }).slice(0, 50);
                        if (!numbers.length) { if (status) status.textContent = 'Enter at least one application number.'; return; }
                        if (btn) btn.disabled = true;
                        if (status) { status.textContent = 'Adding ' + numbers.length + '...'; status.style.color = ''; }
                        try {
                            var res = await fetch('/api/user/watchlist/bulk', {
                                method: 'POST', credentials: 'include',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    applications: numbers.map(function(n) {
                                        return { application_number: n, embassy_slug: form.elements['embassy_slug'].value };
                                    }),
                                    notify_email: true, notify_push: true
                                })
                            });
                            var data = await res.json().catch(function() { return {}; });
                            if (res.ok) {
                                if (status) {
                                    status.textContent = 'Added ' + (data.added || 0) + ', skipped ' + (data.skipped || 0) +
                                        (data.rejected && data.rejected.length ? ', invalid ' + data.rejected.length : '') + '.';
                                    status.style.color = 'var(--green)';
                                }
                                form.reset();
                                paintWatchlist();
                            } else if (status) {
                                status.textContent = data.error || 'Could not add these applications.';
                                status.style.color = 'var(--red)';
                            }
                        } catch (err) {
                            if (status) { status.textContent = 'Could not add these applications.'; status.style.color = 'var(--red)'; }
                        } finally { if (btn) btn.disabled = false; }
                    });
                }
                var exportBtn = document.getElementById('watch-export-btn');
                if (exportBtn && exportBtn.dataset.wired !== '1') {
                    exportBtn.dataset.wired = '1';
                    exportBtn.addEventListener('click', function() { window.location.href = '/api/user/export'; });
                }
            }

            // ====== HOME TAB ======
            // Two-phase render: layout (cards + searchbar + empty table shell)
            // paints ONCE per tab switch. paintHomeRows() then only updates the
            // tbody innerHTML and the results-count node on every search keystroke
            // or filter change - the input element stays alive so no cursor
            // restoration is needed.
            function renderHomeLayout(rows) {
                trackConversion('alert_cta_view', 'home');
                if (!rows.length) return renderConfigWarning() +
                    '<div class="empty">No decisions recorded yet.</div>';
                const byDate = groupByDate(rows);
                const latest = byDate[0];
                if (!latest) return renderConfigWarning() +
                    '<div class="empty">No decisions recorded yet.</div>';
                const real = realRows(rows);
                // Newest day with real data (the latest Excel file's date); the
                // top day may instead be a placeholder notice like "no file yet".
                const latestRealDay = byDate.find(d => realRows(d[1]).length);
                const latestPlaceholder = !realRows(latest[1]).length ? latest[1][0] : null;
                const latestDate = latestRealDay ? latestRealDay[0] : latest[0];
                const prevRealDay = latestRealDay
                    ? byDate.slice(byDate.indexOf(latestRealDay) + 1).find(d => realRows(d[1]).length)
                    : null;
                const latestCount = latestRealDay ? realRows(latestRealDay[1]).length : 0;
                const dayDiff = prevRealDay ? latestCount - realRows(prevRealDay[1]).length : 0;
                const avg = avgDailyApps(byDate);
                const total = real.length;
                const accepted = real.filter(r => r._status === 'accepted').length;
                const rejected = real.filter(r => r._status === 'rejected').length;

                return renderConfigWarning() +
                    staleBannerHTML() +
                    publishStatusHTML(rows) +
                    sinceBannerHTML(rows) +
                    '<div id="meta-box" aria-live="polite"></div>' +
                    activationSection() +
                    readmeSection() +
                    '<div class="latest-date">Latest available data: <strong>' + weekdayLong(latestDate) +
                    '</strong></div>' +
                    '<div class="tracking-since">Tracking started ' + weekdayLong(TRACKING_STARTED) + '</div>' +
                    (latestPlaceholder ? '<div class="ph-banner">' + placeholderNote(latestPlaceholder.decision) + '</div>' : '') +
                    '<div class="note" style="margin-bottom:16px;">' +
                    '<ul style="margin:0; padding-left:18px; list-style-type: disc;">' +
                    '<li>The latest Excel file from the embassy contains decisions up to <strong>' + weekdayLong(latestDate) + '</strong>. This website includes all decisions recorded up to that date.</li>' +
                    '<li>The Irish Embassy Delhi typically uploads the Excel file at <strong>11:00 AM IST</strong> each day. For the freshest updates, check this page around <strong>11:15 AM IST</strong>.</li>' +
                    '<li>The embassy\'s Excel file is sorted by <strong>application number</strong>, not decision date \u2014 so a day\'s count can\'t be verified by counting rows from the end of the file.</li>' +
                    '</ul>' +
                    '</div>' +
                    renderVisaTypeBreakdown(rows) +
                    renderDecisionTrendsChart(rows) +
                    renderCohortAnalysis(rows) +
                    renderAnomalyAlerts(rows) +
                    '<div class="searchbar">' + searchIcon() +
                    '<input type="text" id="home-search" name="q" list="home-suggestions" autocomplete="off" maxlength="200" aria-label="Search by application number" placeholder="Search by application number\u2026" value="' +
                    escapeHtml(homeSearchTerm) + '"></div>' +
                    '<datalist id="home-suggestions"></datalist>' +
                    '<div class="toolbar-row">' +
                    '<div id="recent-searches">' + recentSearchesHTML() + '</div>' +
                    '<div style="display:flex;align-items:center;gap:8px;margin-left:auto;">' +
                    '<button type="button" class="export-btn tu-btn" id="home-search-clear" title="Clear the search and show every result" hidden>Clear search</button>' +
                    '<button type="button" class="export-btn" id="home-export" title="Download the current results as CSV">Export CSV</button>' +
                    '<button type="button" class="export-btn" id="home-export-excel" title="Download the current results as Excel">Export Excel</button>' +
                    '<button type="button" class="export-btn" id="home-export-pdf" title="Download the current results as PDF">Export PDF</button>' +
                    '</div>' +
                    '</div>' +
                    '<div id="watch-area"></div>' +
                    '<div class="cards">' +
                    '<div class="card"><div class="label"><i data-lucide="trending-up"></i>Day-on-day change</div><div class="value ' + (latestPlaceholder ? '' : (dayDiff >= 0 ? 'green' : 'red')) + '">' +
                    (latestPlaceholder ? '-' : ((dayDiff >= 0 ? '+' : '') + dayDiff)) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>Avg applications/day</div><div class="value">' + avg.toFixed(1) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="check-circle"></i>Acceptance rate</div><div class="value green">' + fmtPct(accepted / total) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="x-circle"></i>Rejection rate</div><div class="value red">' + fmtPct(rejected / total) + '</div></div>' +
                    '</div>' +
                    '<div id="community-box"></div>' +
                    '<div class="note" id="home-results-count" aria-live="polite" style="margin-bottom:8px;margin-top:0;"></div>' +
                    '<div class="table-wrap"><table class="results-table"><thead><tr><th>Date</th><th>Application No.</th><th>Decision</th></tr></thead>' +
                    '<tbody id="home-rows"></tbody></table></div>';
            }

            function paintHomeRows() {
                var tbody = document.getElementById('home-rows');
                if (!tbody) return;
                // Disconnect any prior infinite-scroll observer from a previous filter state.
                if (tbody._sentinelObs) { tbody._sentinelObs.disconnect(); tbody._sentinelObs = null; }
                while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
                var rows = cache || [];
                var isSearching = homeSearchTerm.trim().length > 0;
                var visible;
                var latestPlaceholder = null;
                if (isSearching) {
                    // Normalized matching: dashes, spaces and leading zeros in
                    // the query (or the stored number) don't block a match. A
                    // query that normalizes to nothing (punctuation-only)
                    // matches nothing, not everything.
                    var term = normalizeIRL(homeSearchTerm);
                    visible = term ? rows.filter(function(r) { return !r._placeholder && normalizeIRL(r.irl).indexOf(term) !== -1; }) : [];
                } else {
                    var byDate = groupByDate(rows);
                    var latest = byDate.length ? byDate[0] : null;
                    if (latest) {
                        var latestReal = realRows(latest[1]);
                        if (!latestReal.length) latestPlaceholder = latest[1][0];
                        visible = latestReal;
                    } else {
                        visible = [];
                    }
                }
                var countNote = document.getElementById('home-results-count');
                if (countNote) {
                    if (isSearching) {
                        countNote.textContent = visible.length + ' match(es) for "' + homeSearchTerm + '"';
                    } else if (latestPlaceholder) {
                        countNote.textContent = 'No decisions file published for ' + latestPlaceholder.date + ' yet.';
                    } else {
                        var byDate2 = groupByDate(rows);
                        var lat = byDate2.length ? byDate2[0] : null;
                        countNote.textContent = lat
                            ? ('All results for ' + lat[0] + ' (' + realRows(lat[1]).length + ' rows)')
                            : '';
                    }
                }
                if (latestPlaceholder) {
                    tbody.innerHTML = '<tr class="ph-row"><td class="mono">' + latestPlaceholder.date +
                        '</td><td colspan="2">' + placeholderNote(latestPlaceholder.decision) + '</td></tr>';
                    return;
                }
                renderRowsProgressive(tbody, visible);
                // Type-ahead: refresh the datalist from the current match set (or
                // the newest rows when idle) so suggestions narrow as you type.
                const suggEl = document.getElementById('home-suggestions');
                if (suggEl) {
                    const suggRows = isSearching ? visible : (cache || []).slice(0, 300);
                    const seen = {};
                    const opts = [];
                    for (let i = 0; i < suggRows.length && opts.length < 50; i++) {
                        const s = suggRows[i];
                        if (s._placeholder || seen[s.irl]) continue;
                        seen[s.irl] = 1;
                        opts.push('<option value="' + escapeHtml(s.irl) + '"></option>');
                    }
                    suggEl.innerHTML = opts.join('');
                }
                paintWatch();
                paintCommunityBox();
            }

            // Watched numbers (item 5): "Watch" button for the current search,
            // removable chips for saved ones, and a heads-up banner the moment
            // a watched number appears in the data.
            var _watchMemo = { rows: null, list: '', hits: [] };
            function paintWatch() {
                var box = document.getElementById('watch-area');
                if (!box) return;
                var list = getWatchlist();
                // Memoize: same data + same list = same hits. Without this,
                // every debounced keystroke would re-scan 33k rows per term.
                var rows = cache || [];
                var key = list.join(',');
                var hits;
                if (_watchMemo.rows === rows && _watchMemo.list === key) {
                    hits = _watchMemo.hits;
                } else {
                    hits = list.length ? checkWatchlist(rows, list) : [];
                    _watchMemo = { rows: rows, list: key, hits: hits };
                }
                var html = '';
                hits.forEach(function(h) {
                    html += '<div class="status-line pub-live" role="status">Heads up: <strong>' +
                        escapeHtml(h.term) + '</strong> was ' + escapeHtml(h.row.decision || '-') +
                        ' on ' + escapeHtml(h.row.date) + '.</div>';
                });
                var term = normalizeIRL(homeSearchTerm);
                if (term && list.indexOf(term) === -1) {
                    html += '<div style="margin:8px 0;"><button type="button" class="export-btn" data-watch-add="' +
                        escapeHtml(term) + '" title="Get notified here when this number appears">Watch ' +
                        escapeHtml(homeSearchTerm.trim()) + '</button></div>';
                }
                if (list.length) {
                    html += '<div class="recent-row"><span class="recent-label">Watched:</span>' +
                        list.map(function(t) {
                            var hit = hits.some(function(h) { return h.term === t; });
                            return '<button type="button" class="recent-chip" data-watch-del="' + escapeHtml(t) +
                                '" title="Stop watching ' + escapeHtml(t) + '">' + escapeHtml(t) +
                                (hit ? ' \u25cf' : '') + ' \u00d7</button>';
                        }).join('') + '</div>';
                }
                box.innerHTML = html;
            }


            // ====== USER-CONTRIBUTED TIMELINES UI ======
            function renderCommunityTimelinesUI() {
                return '<div class="community-timelines">' +
                    '<h3>Community Timelines</h3>' +
                    '<p class="note2">Share your visa timeline to help others. Data is published anonymously in aggregate.</p>' +
                    '<form id="timeline-form" class="timeline-form" novalidate>' +
                    '<input type="hidden" name="tracker" value="visa" />' +
                    '<div class="timeline-row">' +
                    '<div class="timeline-field"><label>Visa Type</label>' +
                    '<select name="visa_type" required>' +
                    '<option value="">Select...</option>' +
                    '<option value="study">Study</option>' +
                    '<option value="work">Work</option>' +
                    '<option value="visit">Visit</option>' +
                    '<option value="family">Family</option>' +
                    '<option value="transit">Transit</option>' +
                    '<option value="research">Research</option>' +
                    '</select></div>' +
                    '<div class="timeline-field"><label>Applied On</label>' +
                    '<input type="date" name="applied" required data-calendar></div>' +
                    '<div class="timeline-field"><label>Decided On</label>' +
                    '<input type="date" name="decided" required data-calendar></div>' +
                    '<div class="timeline-field"><label>Outcome</label>' +
                    '<select name="outcome" required>' +
                    '<option value="granted">Granted</option>' +
                    '<option value="refused">Refused</option>' +
                    '</select></div>' +
                    '</div>' +
                    '<button class="btn" type="submit">Share Timeline</button>' +
                    '<div class="note" id="timeline-status" aria-live="polite"></div>' +
                    '</form>' +
                    '<div id="community-stats" class="community-stats"></div>' +
                    '</div>';
            }

            // Community-reported waits panel (item 6). Filled once per layout
            // render (guarded by dataset.done); the JSON is cached after first
            // load so repeat visits cost nothing.
            function communityBoxHTML(stats, tracker) {
                var where = tracker === '1g' ? 'Stamp 1G renewals' : 'embassy visas';
                var link = tracker === '1g'
                    ? '<a href="?tracker=1g">Share your timeline</a>'
                    : '<a href="?tracker=visa&tab=suggest">Share your timeline</a>';
                var head = '<div class="g1-chart"><h3><i data-lucide="users" style="width:15px;height:15px;vertical-align:-2px;"></i> Community waits</h3>';
                if (!stats) {
                    return head + '<div class="note2">No community timelines for ' + where +
                        ' yet - ' + link + ' and help others plan.</div></div>';
                }
                var med = Math.round(stats.median * 10) / 10;
                return head + '<div class="note2">Median <strong>' + med + (med === 1 ? ' day' : ' days') +
                    '</strong> from apply to decision across <strong>' + stats.n + '</strong> community report' +
                    (stats.n === 1 ? '' : 's') + ' for ' + where + '. ' + link + '.</div></div>';
            }

            function paintCommunityBox(tracker) {
                tracker = tracker || 'visa';
                var box = document.getElementById('community-box');
                if (!box || box.dataset.done) return;
                box.dataset.done = '1';
                loadCommunity().then(function(rows) {
                    if (!document.getElementById('community-box')) return;
                    box.innerHTML = communityBoxHTML(communityStats(rows, tracker), tracker);
                });
            }

            // Find nearest neighbours for application number search
            function findNearestNeighbours(appNum, decisions, count = 2) {
                var nums = decisions
                    .filter(function(d) { return !d._placeholder; })
                    .map(function(d) { return parseInt(d.number, 10); })
                    .sort(function(a, b) { return a - b; });
                var target = parseInt(appNum, 10);
                if (isNaN(target)) return [];
                
                var idx = nums.findIndex(function(n) { return n >= target; });
                
                var neighbours = [];
                if (idx > 0) neighbours.push(decisions.find(function(d) { return parseInt(d.number, 10) === nums[idx - 1]; }));
                if (idx < nums.length) neighbours.push(decisions.find(function(d) { return parseInt(d.number, 10) === nums[idx]; }));
                if (idx > 1) neighbours.push(decisions.find(function(d) { return parseInt(d.number, 10) === nums[idx - 2]; }));
                if (idx < nums.length - 1) neighbours.push(decisions.find(function(d) { return parseInt(d.number, 10) === nums[idx + 1]; }));
                
                // Deduplicate and limit
                var seen = {};
                var unique = [];
                neighbours.forEach(function(n) {
                    if (n && !seen[n.number]) {
                        seen[n.number] = true;
                        unique.push(n);
                    }
                });
                return unique.slice(0, count * 2);
            }

            function renderNearestNeighbours(neighbours, searchTerm) {
                var html = '<tr class="empty-row"><td colspan="3" class="empty" style="text-align:left;">' +
                    '<strong>No exact match for ' + escapeHtml(searchTerm) + '.</strong>' +
                    '<p style="margin:8px 0 0; font-size:13px; color:var(--ink-soft);">Nearest neighbours:</p>' +
                    '<table style="width:100%; margin-top:8px; border-collapse:collapse;">' +
                    '<thead><tr><th>Application No.</th><th>Date</th><th>Decision</th></tr></thead>' +
                    '<tbody>';
                
                neighbours.forEach(function(n) {
                    var diff = parseInt(n.number, 10) - parseInt(searchTerm, 10);
                    var diffStr = diff > 0 ? '+' + diff : diff;
                    var statusClass = n._status === 'accepted' ? 'green' : (n._status === 'rejected' ? 'red' : '');
                    html += '<tr><td class="mono">' + escapeHtml(n.number) + 
                        '<span style="margin-left:8px; font-size:11px; color:var(--ink-muted);">(' + diffStr + ')</span></td>' +
                        '<td>' + escapeHtml(n.date) + '</td>' +
                        '<td><span class="pill ' + statusClass + '">' + escapeHtml(n.decision) + '</span></td></tr>';
                });
                
                html += '</tbody></table></td></tr>';
                return html;
            }

            // Append a list of rows to a tbody progressively: render first CHUNK
            // synchronously, then use IntersectionObserver to append more chunks as
            // the user scrolls toward the sentinel row. Bounds the initial layout
            // cost so a 5,000-row filter is no heavier than a 100-row one.
            function renderRowsProgressive(tbody, rows) {
                var CHUNK = 100;
                if (!rows.length) {
                    // Find nearest neighbours when searching for a specific application number
                    var term = normalizeIRL(homeSearchTerm);
                    if (term && /^\d+$/.test(term)) {
                        var neighbours = findNearestNeighbours(term, cache || []);
                        if (neighbours.length) {
                            tbody.innerHTML = renderNearestNeighbours(neighbours, term);
                            return;
                        }
                    }
                    tbody.innerHTML = '<tr><td colspan="3" class="empty">No matches.</td></tr>';
                    return;
                }
                if (rows.length <= CHUNK) {
                    tbody.innerHTML = rows.map(function(r) { return r._html; }).join('');
                    return;
                }
                tbody.innerHTML = rows.slice(0, CHUNK).map(function(r) { return r._html; }).join('');
                var sentinel = document.createElement('tr');
                sentinel.className = 'row-sentinel';
                sentinel.innerHTML = '<td colspan="3" style="height:18px;"></td>';
                tbody.appendChild(sentinel);
                var rendered = CHUNK;
                var obs = new IntersectionObserver(function(entries) {
                    if (!entries[0].isIntersecting) return;
                    if (rendered >= rows.length) {
                        sentinel.remove();
                        obs.disconnect();
                        tbody._sentinelObs = null;
                        return;
                    }
                    var next = rows.slice(rendered, rendered + CHUNK);
                    sentinel.insertAdjacentHTML('beforebegin', next.map(function(r) { return r._html; }).join(''));
                    rendered += next.length;
                    if (rendered >= rows.length) {
                        sentinel.remove();
                        obs.disconnect();
                        tbody._sentinelObs = null;
                    }
                }, { rootMargin: '400px' });
                obs.observe(sentinel);
                tbody._sentinelObs = obs;
            }

            function toggleDayDetail(t, detail) {
                const open = detail.classList.toggle('open');
                t.setAttribute('aria-expanded', open ? 'true' : 'false');
                const caret = t.querySelector('.dd-caret');
                if (caret) caret.textContent = open ? '\u25be' : '\u25b8';
            }

            // ---- search power-ups + export ----
            // Matching ignores formatting: dashes, spaces and leading zeros are
            // stripped, so "8540-8562" and "085408562" both find "85408562".
            function normalizeIRL(s) {
                return String(s == null ? '' : s).replace(/\D/g, '').replace(/^0+/, '');
            }
            function getRecentSearches() {
                try {
                    const raw = JSON.parse(localStorage.getItem('visa-recent-searches') || '[]');
                    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x.trim()).slice(0, 5) : [];
                } catch (e) { return []; }
            }
            function saveRecentSearch(term) {
                term = (term || '').trim();
                if (!term) return;
                try {
                    const list = getRecentSearches().filter(t => t !== term);
                    list.unshift(term);
                    localStorage.setItem('visa-recent-searches', JSON.stringify(list.slice(0, 5)));
                } catch (e) { /* private mode */ }
            }
            function recentSearchesHTML() {
                const list = getRecentSearches();
                if (!list.length) return '';
                return '<div class="recent-row"><span class="recent-label">Recent:</span>' +
                    list.map(t => '<button type="button" class="recent-chip" data-q="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>').join('') +
                    '</div>';
            }
            function refreshRecentChips() {
                const el = document.getElementById('recent-searches');
                if (el) el.innerHTML = recentSearchesHTML();
            }
            function exportCSV(rows, filename) {
                const esc = function(v) {
                    v = String(v == null ? '' : v);
                    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
                };
                const lines = ['Date,Application Number,Decision'];
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    lines.push(esc(r.date) + ',' + esc(r.irl) + ',' + esc(r.decision));
                }
                const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(function() { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 0);
            }

            // Excel export using SheetJS
            async function exportExcel(rows, filename) {
                await LazyLoader.xlsx();
                const wb = XLSX.utils.book_new();
                
                // Sheet 1: All Data
                const allData = [['Date', 'Application Number', 'Decision', 'Embassy']];
                rows.forEach(r => allData.push([r.date, r.irl, r.decision, r.embassy || 'N/A']));
                const ws1 = XLSX.utils.aoa_to_sheet(allData);
                XLSX.utils.book_append_sheet(wb, ws1, 'All Decisions');
                
                // Sheet 2: By Embassy
                const byEmbassy = {};
                rows.forEach(r => {
                    const emb = r.embassy || 'unknown';
                    if (!byEmbassy[emb]) byEmbassy[emb] = [];
                    byEmbassy[emb].push([r.date, r.irl, r.decision]);
                });
                Object.keys(byEmbassy).sort().forEach(emb => {
                    const data = [['Date', 'Application Number', 'Decision']].concat(byEmbassy[emb]);
                    const ws = XLSX.utils.aoa_to_sheet(data);
                    XLSX.utils.book_append_sheet(wb, ws, emb.substring(0, 31));
                });
                
                // Sheet 3: By Month
                const byMonth = {};
                rows.forEach(r => {
                    const m = r.date.substring(0, 7);
                    if (!byMonth[m]) byMonth[m] = { total: 0, approved: 0, rejected: 0 };
                    byMonth[m].total++;
                    if (r._status === 'accepted') byMonth[m].approved++;
                    else if (r._status === 'rejected') byMonth[m].rejected++;
                });
                const monthData = [['Month', 'Total', 'Approved', 'Rejected', 'Rate %']];
                Object.keys(byMonth).sort().forEach(m => {
                    const d = byMonth[m];
                    monthData.push([m, d.total, d.approved, d.rejected, d.total ? (d.approved / d.total * 100).toFixed(1) : 0]);
                });
                const ws3 = XLSX.utils.aoa_to_sheet(monthData);
                XLSX.utils.book_append_sheet(wb, ws3, 'Monthly Summary');
                
                XLSX.writeFile(wb, filename);
            }

            // PDF export using jsPDF + autoTable
            async function exportPDF(rows, filename) {
                await LazyLoader.jspdf();
                await LazyLoader.jspdfAutotable();
                const { jsPDF } = window.jspdf;
                const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
                
                doc.setFontSize(16);
                doc.text('Irish Visa Decision Tracker - Export', 40, 40);
                doc.setFontSize(10);
                doc.text('Generated: ' + new Date().toISOString().slice(0, 10), 40, 55);
                doc.text('Total rows: ' + rows.length, 40, 70);
                
                const tableData = rows.map(r => [r.date, r.irl, r.decision, r.embassy || 'N/A']);
                doc.autoTable({
                    head: [['Date', 'Application Number', 'Decision', 'Embassy']],
                    body: tableData,
                    startY: 80,
                    styles: { fontSize: 7, cellPadding: 2 },
                    headStyles: { fillColor: [5, 150, 105] },
                    margin: { left: 40, right: 40 }
                });
                
                doc.save(filename);
            }

            // Busiest-days heatmap: a GitHub-style grid of the last ~14 weeks,
            // each column a Sun-Sat week, shaded by decision volume.
            function heatmapHTML(byDate) {
                const counts = new Map();
                byDate.forEach(([date, dayRows]) => {
                    counts.set(date, dayRows.filter(r => !r._placeholder).length);
                });
                const ist = istNow();
                const start = new Date(ist);
                start.setUTCDate(start.getUTCDate() - 90);
                start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back to Sunday
                const cells = [];
                const cur = new Date(start);
                while (cur <= ist) {
                    const iso = cur.toISOString().slice(0, 10);
                    const n = counts.get(iso) || 0;
                    const lvl = n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 10 ? 3 : 4;
                    cells.push('<div class="heat-cell heat-' + lvl + '" title="' + iso +
                        (n ? ' \u00b7 ' + n + ' decision' + (n === 1 ? '' : 's') : ' \u00b7 no decisions') + '"></div>');
                    cur.setUTCDate(cur.getUTCDate() + 1);
                }
                return '<div class="heat-wrap">' +
                    '<div class="heat-head"><span class="note2">Decisions per day, last 14 weeks</span>' +
                    '<span class="heat-legend">less <span class="heat-cell heat-0"></span><span class="heat-cell heat-1"></span><span class="heat-cell heat-2"></span><span class="heat-cell heat-3"></span><span class="heat-cell heat-4"></span> more</span></div>' +
                    '<div class="heat-grid" role="img" aria-label="Decision volume per day for the last 14 weeks; darker blue means more decisions">' + cells.join('') + '</div>' +
                    '</div>';
            }

            function renderDailySummary(rows) {
                if (!rows.length) return renderConfigWarning() +
                    '<div class="empty">No decisions recorded yet.</div>';
                const byDate = groupByDate(rows);
                const trs = byDate.map(([date, dayRows], idx) => {
                    const real = dayRows.filter(r => !r._placeholder);
                    const placeholder = dayRows.find(r => r._placeholder);
                    if (!real.length) {
                        // Notice day (no file / office closed): show the real
                        // message instead of counting the notice as 1 application.
                        return '<tr class="ph-row"><td class="mono">' + date + '</td><td colspan="4">' +
                            placeholderNote(placeholder ? placeholder.decision : '') + '</td></tr>';
                    }
                    // Day-on-day compares against the previous day that has REAL
                    // data, so placeholder days don't skew the delta.
                    const prevReal = byDate.slice(idx + 1).find(d => d[1].some(r => !r._placeholder));
                    const prevCount = prevReal ? realRows(prevReal[1]).length : null;
                    const diff = prevCount === null ? null : real.length - prevCount;
                    const acc = real.filter(r => classify(r.decision) === 'accepted').length / real.length;
                    const rej = real.filter(r => classify(r.decision) === 'rejected').length / real.length;
                    return '<tr><td class="mono dd-toggle" role="button" tabindex="0" aria-expanded="false" title="Show the applications behind this day\u2019s numbers">' +
                        '<span class="dd-caret" aria-hidden="true">\u25b8</span>' + date + '</td><td>' + real.length + '</td><td>' +
                        (diff === null ? '-' : ('<span class="pill ' + (diff >= 0 ? 'green' : 'red') + '">' + (
                            diff >= 0 ? '+' : '') + diff + '</span>')) +
                        '</td><td>' + fmtPct(acc) + '</td><td>' + fmtPct(rej) + '</td></tr>' +
                        '<tr class="dd-row"><td colspan="5"><div class="dd-note">These ' + real.length +
                        ' rows were first recorded on this day. The embassy file is sorted by application number, so this is the day the tracker first saw them, not their decision date.</div>' +
                        '<div class="dd-list">' + real.map(function(r) {
                            return '<div class="dd-list-item"><span class="mono">' + escapeHtml(r.irl) +
                                '</span><span class="pill ' + r._pillClass + '">' + escapeHtml(r.decision || '-') + '</span></div>';
                        }).join('') + '</div></td></tr>';
                }).join('');
                return renderConfigWarning() +
                    heatmapHTML(byDate) +
                    '<div class="table-wrap"><table class="daily-table"><thead><tr><th>Date</th><th>Applications Processed</th><th>Day-on-Day</th><th>Acceptance Rate</th><th>Rejection Rate</th></tr></thead>' +
                    '<tbody>' + trs + '</tbody></table></div>';
            }

            // ====== PAST TAB ======
            // Same layout/rows split as Home: renderPastLayout() paints the cards,
            // filter row, empty tbody shell, and scroll-to-top button ONCE per tab
            // switch. paintPastRows() then only updates the tbody + count note
            // when the date filter changes - the datepicker stays alive so no
            // cursor restoration is needed.
            function renderPastLayout(rows) {
                if (!rows.length) return renderConfigWarning() +
                    '<div class="empty">No decisions recorded yet.</div>';
                const real = realRows(rows);
                const total = real.length;
                const accepted = real.filter(r => r._status === 'accepted').length;
                const rejected = real.filter(r => r._status === 'rejected').length;
                const byDate = groupByDate(rows);
                const avg = avgDailyApps(byDate);
                const thisWeek = real.filter(r => daysAgo(r.date) < 7).length;
                const lastWeek = real.filter(r => daysAgo(r.date) >= 7 && daysAgo(r.date) < 14).length;
                const wow = lastWeek ? (thisWeek - lastWeek) / lastWeek : null;
                // Rolling windows so a trend doesn't drown in all-time history.
                const last7 = real.filter(r => daysAgo(r.date) < 7);
                const last30 = real.filter(r => daysAgo(r.date) < 30);
                const acc7 = last7.length ? last7.filter(r => r._status === 'accepted').length / last7.length : null;
                const acc30 = last30.length ? last30.filter(r => r._status === 'accepted').length / last30.length : null;

                return renderConfigWarning() +
                    '<div class="cards">' +
                    '<div class="card"><div class="label"><i data-lucide="check-circle"></i>Acceptance rate</div><div class="value green">' + fmtPct(accepted / total) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>7-day acceptance</div><div class="value ' + (acc7 === null ? '' : 'green') + '">' + (acc7 === null ? '-' : fmtPct(acc7)) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-days"></i>30-day acceptance</div><div class="value ' + (acc30 === null ? '' : 'green') + '">' + (acc30 === null ? '-' : fmtPct(acc30)) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="x-circle"></i>Rejection rate</div><div class="value red">' + fmtPct(rejected / total) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>Avg applications/day</div><div class="value">' + avg.toFixed(1) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="percent"></i>Week-on-week</div><div class="value ' + (wow === null ? '' : (wow >= 0 ? 'green' : 'red')) + '">' + (wow === null ? '-' : ((wow >= 0 ? '+' : '') + fmtPct(wow))) + '</div></div>' +
                    '</div>' +
                    '<div class="filter-row">' +
                    '<div class="note" style="margin-top:0;">Use the search bar on the Home tab to look up a specific application number.</div>' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                    '<span id="past-status-filter"></span>' +
                    '<button type="button" class="export-btn" id="past-export" title="Download the visible rows as CSV">Export CSV</button>' +
                    '<button type="button" class="export-btn" id="past-export-excel" title="Download the visible rows as Excel">Export Excel</button>' +
                    '<button type="button" class="export-btn" id="past-export-pdf" title="Download the visible rows as PDF">Export PDF</button>' +
                    '<div class="datefilter' + (pastDateFilter ? ' has-filter' : '') + '"><label class="visually-hidden" for="past-date-filter">Filter by date</label><input type="date" id="past-date-filter" name="date" autocomplete="off" aria-label="Filter by date" value="' + escapeHtml(pastDateFilter) + '" data-calendar>' +
                    '<button type="button" class="clear-btn" id="past-date-clear" aria-label="Clear date filter" title="Clear date filter">\u00d7</button>' +
                    '</div>' +
                    '</div>' +
                    '</div>' +
                    '<div class="note" id="past-results-count" aria-live="polite" style="margin-bottom:8px;margin-top:0;"></div>' +
                    '<div class="table-wrap"><table class="results-table"><thead><tr><th>Date</th><th>Application No.</th><th>Decision</th></tr></thead>' +
                    '<tbody id="past-rows"></tbody></table></div>' +
                    '<button class="scroll-top-btn" id="scroll-top-btn" title="Scroll to top" aria-label="Scroll to top">\u2191</button>';
            }

            function paintPastRows() {
                var tbody = document.getElementById('past-rows');
                if (!tbody) return;
                if (tbody._sentinelObs) { tbody._sentinelObs.disconnect(); tbody._sentinelObs = null; }
                while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
                var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                var visible = pastDateFilter
                    ? rows.filter(function(r) { return r.date === pastDateFilter; })
                    : rows;
                if (pastStatusFilter !== 'all') {
                    visible = visible.filter(function(r) { return (r._status || classify(r.decision)) === pastStatusFilter; });
                }
                var phNote = null;
                if (pastDateFilter && !visible.length) {
                    var ph = (cache || []).find(function(r) { return r._placeholder && r.date === pastDateFilter; });
                    if (ph) phNote = ph;
                }
                var countNote = document.getElementById('past-results-count');
                if (countNote) {
                    countNote.textContent = phNote
                        ? 'No decisions file for ' + pastDateFilter
                        : (visible.length + ' ' + (pastStatusFilter === 'all' ? 'rows' : pastStatusFilter + ' rows') +
                            (pastDateFilter ? ' for ' + pastDateFilter : ' total'));
                }
                if (phNote) {
                    tbody.innerHTML = '<tr class="ph-row"><td class="mono">' + phNote.date +
                        '</td><td colspan="2">' + placeholderNote(phNote.decision) + '</td></tr>';
                    return;
                }
                renderRowsProgressive(tbody, visible);
            }

            // ====== SUGGEST TAB ======
            // Single-purpose layout: the submission form. A post carrying
            // form-name=suggestions is stored by the Worker in D1; the Worker
            // serves the three timeline forms back (never this one, which
            // carries a name and free text), so a suggestion is read from the
            // store rather than from this page.
            // The form body lives in SUGG_FORM_HTML so it can be restored after
            // the post-submit success card is shown.
            // Minimum time the "Submitting…" state stays visible - on a fast
            // connection the fetch can resolve in a few ms, which would flash
            // the success card before the label was ever readable.
            const MIN_SUBMIT_MS = 800;

            // Markup mirrors the contact-form shape the site has always used:
            // fields wrapped in <p><label>…</label></p>, a hidden `form-name`
            // field naming the form the Worker routes on, and an empty
            // `bot-field` the Worker reads as the honeypot. Nothing registers
            // these forms anywhere - the Worker reads the POST itself.
            const SUGG_FORM_HTML =
                '<input type="hidden" name="form-name" value="suggestions" />' +
                '<p><label>Name <input type="text" id="sugg-name" name="name" placeholder="Your name\u2026" autocomplete="name" /></label></p>' +
                '<p><label>Suggestion <textarea id="sugg-text" name="suggestion" placeholder="Your suggestion\u2026"></textarea></label></p>' +
                '<button class="btn" type="submit" id="sugg-submit">Send Suggestion</button>' +
                '<div class="note" id="sugg-status" aria-live="polite"></div>';

            function renderSuggestLayout() {
                return renderConfigWarning() +
                    '<div class="suggest-grid">' +
                        '<div class="form-col" style="max-width:560px;">' +
                            '<form class="card" id="sugg-form" name="suggestions" novalidate style="max-width:100%;">' +
                                SUGG_FORM_HTML +
                            '</form>' +
                        '</div>' +
                        '<div class="form-col" style="max-width:560px;">' +
                            '<form class="card" id="time-form" name="timelines-visa" novalidate style="max-width:100%;">' +
                                TIMELINES_FORM_HTML +
                            '</form>' +
                        '</div>' +
                        '<div class="form-col" style="max-width:560px;">' +
                            '<form class="card" id="alert-form" name="alert-subscribe" novalidate style="max-width:100%;">' +
                                ALERT_FORM_HTML +
                            '</form>' +
                        '</div>' +
                        '<div class="form-col" style="max-width:560px;">' +
                            renderCommunityTimelinesUI() +
                        '</div>' +
                    '</div>';
            }


            // ====== COHORT ANALYSIS ======
            function renderCohortAnalysis(rows) {
                const real = realRows(rows);
                if (!real.length) return '<p class="note2">No data for cohort analysis</p>';
                
                // Group by application week and track decisions over following weeks
                const cohorts = {};
                real.forEach(r => {
                    if (!r.date || !r.irl) return;
                    // Approximate application week from decision date (rough estimate)
                    const dt = new Date(r.date + 'T00:00:00');
                    const weekStart = new Date(dt);
                    weekStart.setDate(dt.getDate() - dt.getDay());
                    const key = weekStart.toISOString().slice(0, 10);
                    if (!cohorts[key]) cohorts[key] = { total: 0, decided: 0, accepted: 0, rejected: 0 };
                    cohorts[key].total++;
                    cohorts[key].decided++;
                    if (r._status === 'accepted') cohorts[key].accepted++;
                    else if (r._status === 'rejected') cohorts[key].rejected++;
                });
                
                const weeks = Object.keys(cohorts).sort().slice(-8); // Last 8 cohorts
                if (!weeks.length) return '<p class="note2">Insufficient data for cohorts</p>';
                
                let html = '<h3>Weekly Cohort Analysis</h3>';
                html += '<p class="note2">Each row = applications received that week. Columns = % decided within N weeks.</p>';
                html += '<div class="cohort-table"><table class="results-table"><thead>' +
                    '<tr><th>Application Week</th><th>Total Apps</th><th>Decided</th><th>Approval Rate</th></tr></thead><tbody>';
                
                weeks.forEach(w => {
                    const c = cohorts[w];
                    const rate = c.decided ? ((c.accepted / c.decided) * 100).toFixed(1) : 0;
                    const d = new Date(w + 'T00:00:00');
                    const label = d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
                    html += '<tr>' +
                        '<td><strong>' + label + '</strong></td>' +
                        '<td>' + c.total.toLocaleString() + '</td>' +
                        '<td>' + c.decided.toLocaleString() + '</td>' +
                        '<td><strong>' + rate + '%</strong></td>' +
                        '</tr>';
                });
                
                html += '</tbody></table></div>';
                return html;
            }


            // ====== ANOMALY DETECTION ======
            function detectAnomalies(rows) {
                const real = realRows(rows);
                if (real.length < 50) return [];
                
                // Group by day
                const byDay = {};
                real.forEach(r => {
                    if (!r.date) return;
                    if (!byDay[r.date]) byDay[r.date] = { total: 0, accepted: 0, rejected: 0 };
                    byDay[r.date].total++;
                    if (r._status === 'accepted') byDay[r.date].accepted++;
                    else if (r._status === 'rejected') byDay[r.date].rejected++;
                });
                
                const days = Object.keys(byDay).sort();
                if (days.length < 14) return [];
                
                // Calculate rolling averages
                const window = 7;
                const anomalies = [];
                
                for (let i = window; i < days.length; i++) {
                    const day = days[i];
                    const prevDays = days.slice(i - window, i);
                    const avgTotal = prevDays.reduce((s, d) => s + byDay[d].total, 0) / window;
                    const avgRate = prevDays.reduce((s, d) => s + (byDay[d].total ? byDay[d].accepted / byDay[d].total : 0), 0) / window;
                    
                    const today = byDay[day];
                    const todayRate = today.total ? today.accepted / today.total : 0;
                    
                    // Volume anomaly (>2 std devs)
                    const volumes = prevDays.map(d => byDay[d].total);
                    const volMean = volumes.reduce((a,b) => a+b, 0) / window;
                    const volStd = Math.sqrt(volumes.reduce((s,v) => s + Math.pow(v - volMean, 2), 0) / window);
                    if (today.total > volMean + 2 * volStd) {
                        anomalies.push({ type: 'volume_spike', date: day, value: today.total, expected: Math.round(volMean), severity: 'high' });
                    }
                    
                    // Rate anomaly
                    const rates = prevDays.map(d => d.total ? byDay[d].accepted / byDay[d].total : 0);
                    const rateMean = rates.reduce((a,b) => a+b, 0) / window;
                    const rateStd = Math.sqrt(rates.reduce((s,v) => s + Math.pow(v - rateMean, 2), 0) / window);
                    if (rateStd > 0 && Math.abs(todayRate - rateMean) > 2 * rateStd) {
                        anomalies.push({ type: 'rate_shift', date: day, value: (todayRate * 100).toFixed(1) + '%', expected: (rateMean * 100).toFixed(1) + '%', severity: 'medium' });
                    }
                }
                
                return anomalies;
            }

            function renderAnomalyAlerts(rows) {
                const anomalies = detectAnomalies(rows);
                if (!anomalies.length) return '';
                
                const recent = anomalies.filter(a => {
                    const d = new Date(a.date + 'T00:00:00');
                    const diff = (Date.now() - d) / 86400000;
                    return diff <= 14; // Last 2 weeks
                });
                
                if (!recent.length) return '';
                
                let html = '<div class="anomaly-alerts" role="alert">';
                html += '<h3><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 9v4M12 17h.01"/></svg> Data Anomalies Detected</h3>';
                html += '<ul>';
                recent.forEach(a => {
                    const icon = a.type === 'volume_spike' ? 'trending-up' : 'alert-triangle';
                    const color = a.severity === 'high' ? 'var(--red)' : 'var(--amber)';
                    html += '<li style="border-left: 3px solid ' + color + '; padding: 8px 12px; margin: 8px 0; background: var(--surface-raised);">' +
                        '<strong>' + a.date + '</strong>: ' +
                        (a.type === 'volume_spike' ? 
                            'Unusual volume spike: ' + a.value + ' decisions (expected ~' + a.expected + ')' :
                            'Approval rate shift: ' + a.value + ' (expected ~' + a.expected + ')') +
                        '<span class="badge" style="background:' + color + '; margin-left:8px;">' + a.severity + '</span>' +
                        '</li>';
                });
                html += '</ul></div>';
                return html;
            }

            // ====== DECISION BREAKDOWN BY VISA TYPE ======

            // ====== DECISION BREAKDOWN BY VISA TYPE ======
            function renderVisaTypeBreakdown(rows) {
                const real = realRows(rows);
                if (!real.length) return '';
                
                const byType = {};
                real.forEach(r => {
                    const type = r._visaType || 'Unknown';
                    if (!byType[type]) byType[type] = { total: 0, accepted: 0, rejected: 0, other: 0 };
                    byType[type].total++;
                    if (r._status === 'accepted') byType[type].accepted++;
                    else if (r._status === 'rejected') byType[type].rejected++;
                    else byType[type].other++;
                });
                
                if (!Object.keys(byType).length) return '';
                
                let html = '<h3>Decisions by Visa Type</h3>';
                html += '<div class="visa-type-breakdown"><table class="results-table"><thead>' +
                    '<tr><th>Visa Type</th><th>Total</th><th>Approved</th><th>Refused</th><th>Other</th><th>Approval Rate</th></tr></thead><tbody>';
                
                Object.keys(byType).sort().forEach(type => {
                    const d = byType[type];
                    const rate = d.total ? ((d.accepted / d.total) * 100).toFixed(1) : 0;
                    html += '<tr>' +
                        '<td><strong>' + escapeHtml(type) + '</strong></td>' +
                        '<td>' + d.total.toLocaleString() + '</td>' +
                        '<td class="green">' + d.accepted.toLocaleString() + '</td>' +
                        '<td class="red">' + d.rejected.toLocaleString() + '</td>' +
                        '<td>' + d.other.toLocaleString() + '</td>' +
                        '<td><strong>' + rate + '%</strong></td>' +
                        '</tr>';
                });
                
                html += '</tbody></table></div>';
                return html;
            }

            // ====== DECISION TRENDS VISUALIZATION ======

            // ====== DECISION TRENDS VISUALIZATION ======
            function renderDecisionTrendsChart(rows) {
                const real = realRows(rows);
                if (!real.length) return '<p class="note2">No data for trends</p>';
                
                // Group by week
                const byWeek = {};
                real.forEach(r => {
                    if (!r.date) return;
                    const dt = new Date(r.date + 'T00:00:00');
                    const weekStart = new Date(dt);
                    weekStart.setDate(dt.getDate() - dt.getDay()); // Sunday
                    const key = weekStart.toISOString().slice(0, 10);
                    if (!byWeek[key]) byWeek[key] = { accepted: 0, rejected: 0, total: 0 };
                    byWeek[key].total++;
                    if (r._status === 'accepted') byWeek[key].accepted++;
                    else if (r._status === 'rejected') byWeek[key].rejected++;
                });
                
                const weeks = Object.keys(byWeek).sort().slice(-12); // Last 12 weeks
                const labels = weeks.map(w => {
                    const d = new Date(w + 'T00:00:00');
                    return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
                });
                const accepted = weeks.map(w => byWeek[w].accepted);
                const rejected = weeks.map(w => byWeek[w].rejected);
                const rate = weeks.map(w => w.total ? Math.round((byWeek[w].accepted / w.total) * 100) : 0);
                
                const canvasId = 'trends-chart-' + Math.random().toString(36).slice(2);
                const draw = () => {
                    const ctx = document.getElementById(canvasId);
                    if (ctx && !ctx.chart) {
                        ctx.chart = new Chart(ctx, {
                            type: 'line',
                            data: {
                                labels: labels,
                                datasets: [
                                    { label: 'Approved', data: accepted, borderColor: '#059669', backgroundColor: 'rgba(5,150,105,0.1)', fill: true, tension: 0.3 },
                                    { label: 'Refused', data: rejected, borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.1)', fill: true, tension: 0.3 },
                                    { label: 'Approval Rate %', data: rate, borderColor: '#059669', backgroundColor: 'transparent', yAxisID: 'y1', type: 'line', tension: 0.3 }
                                ]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                interaction: { mode: 'index', intersect: false },
                                scales: {
                                    y: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'Count' } },
                                    y1: { type: 'linear', position: 'right', min: 0, max: 100, title: { display: true, text: 'Rate %' }, grid: { drawOnChartArea: false } }
                                },
                                plugins: { legend: { position: 'top' } }
                            }
                        });
                    }
                };
                if (typeof Chart !== 'undefined') {
                    setTimeout(draw, 0);
                } else {
                    // Render the canvas first, then draw once the lazy loader resolves.
                    LazyLoader.chart().then(() => setTimeout(draw, 0)).catch((err) => {
                        console.error('Failed to load Chart.js for trends:', err);
                        const host = document.getElementById(canvasId);
                        if (host && host.parentNode) host.parentNode.innerHTML = '<div class="chart-placeholder">Chart.js not loaded</div>';
                    });
                }
                
                return '<div class="chart-container" style="height:300px;"><canvas id="' + canvasId + '"></canvas></div>';
            }

            // ====== ANALYTICS TAB ======
            function renderAnalyticsLayout(rows) {
                if (!rows.length) return renderConfigWarning() +
                    '<div class="empty">No decisions recorded yet.</div>';
                
                return renderConfigWarning() +
                    renderVisaTypeBreakdown(rows) +
                    renderDecisionTrendsChart(rows) +
                    renderCohortAnalysis(rows) +
                    renderAnomalyAlerts(rows) +
                    '<div class="analytics-grid">' +
                        '<div class="chart-container">' +
                            '<h3>Month-by-Month Approval Rate</h3>' +
                            '<canvas id="chart-monthly" aria-label="Monthly approval rate chart"></canvas>' +
                        '</div>' +
                        '<div class="chart-container">' +
                            '<h3>30-Day Rolling Approval Rate</h3>' +
                            '<canvas id="chart-rolling30" aria-label="30-day rolling approval rate chart"></canvas>' +
                        '</div>' +
                        '<div class="chart-container">' +
                            '<h3>Daily Volume Delta</h3>' +
                            '<canvas id="chart-daily-delta" aria-label="Daily volume delta chart"></canvas>' +
                        '</div>' +
                        '<div class="chart-container">' +
                            '<h3>Queue Density (Application Number Distribution)</h3>' +
                            '<canvas id="chart-queue-density" aria-label="Queue density histogram"></canvas>' +
                        '</div>' +
                    '</div>';
            }

            function paintAnalyticsCharts() {
                var rows = cache || [];
                if (!rows.length) return;
                
                // Compute analytics data
                var monthly = computeMonthly(rows);
                var rolling30 = computeRolling30(rows);
                var dailyDelta = computeDailyDelta(rows);
                var queueDensity = computeQueueDensity(rows);
                
                // Load Chart.js using LazyLoader
                LazyLoader.chart().then(function() {
                    drawCharts(monthly, rolling30, dailyDelta, queueDensity);
                }).catch(function(err) {
                    console.error('Failed to load Chart.js:', err);
                });
            }
            
            function drawCharts(monthly, rolling30, dailyDelta, queueDensity) {
                var ctx;
                
                // Monthly chart (bar + line)
                ctx = document.getElementById('chart-monthly');
                if (ctx) {
                    new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: monthly.map(m => m.month),
                            datasets: [{
                                label: 'Total Applications',
                                data: monthly.map(m => m.total),
                                backgroundColor: 'rgba(5, 150, 105, 0.3)',
                                borderColor: '#059669',
                                borderWidth: 1,
                                yAxisID: 'y'
                            }, {
                                label: 'Approved',
                                data: monthly.map(m => m.approved),
                                backgroundColor: 'rgba(5, 150, 105, 0.6)',
                                borderColor: '#047857',
                                borderWidth: 1,
                                yAxisID: 'y'
                            }, {
                                label: 'Approval Rate (%)',
                                data: monthly.map(m => m.rate),
                                type: 'line',
                                borderColor: '#dc2626',
                                backgroundColor: 'rgba(220, 38, 38, 0.1)',
                                borderWidth: 2,
                                fill: false,
                                tension: 0.3,
                                yAxisID: 'y1',
                                pointRadius: 4,
                                pointHoverRadius: 6
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            scales: {
                                y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Applications' } },
                                y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Rate (%)' }, min: 0, max: 100, grid: { drawOnChartArea: false } }
                            },
                            plugins: { legend: { display: true, position: 'top' } }
                        }
                    });
                }
                
                // Rolling 30-day chart
                ctx = document.getElementById('chart-rolling30');
                if (ctx) {
                    new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: rolling30.map(r => r.date),
                            datasets: [{
                                label: '30-Day Rolling Approval Rate (%)',
                                data: rolling30.map(r => r.rate),
                                borderColor: '#059669',
                                backgroundColor: 'rgba(5, 150, 105, 0.1)',
                                borderWidth: 2,
                                fill: true,
                                tension: 0.3,
                                pointRadius: 2,
                                pointHoverRadius: 4
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: {
                                y: { min: 0, max: 100, title: { display: true, text: 'Approval Rate (%)' } },
                                x: { ticks: { maxTicksLimit: 10 } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
                
                // Daily delta chart
                ctx = document.getElementById('chart-daily-delta');
                if (ctx) {
                    new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: dailyDelta.map(d => d.date),
                            datasets: [{
                                label: 'Volume',
                                data: dailyDelta.map(d => d.volume),
                                backgroundColor: dailyDelta.map(d => d.volume >= 0 ? 'rgba(5, 150, 105, 0.6)' : 'rgba(220, 38, 38, 0.6)'),
                                borderColor: dailyDelta.map(d => d.volume >= 0 ? '#059669' : '#dc2626'),
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: {
                                y: { title: { display: true, text: 'Applications' } },
                                x: { ticks: { maxTicksLimit: 10 } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
                
                // Queue density chart
                ctx = document.getElementById('chart-queue-density');
                if (ctx) {
                    new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: queueDensity.bins.map(b => b.label),
                            datasets: [{
                                label: 'Applications in Range',
                                data: queueDensity.bins.map(b => b.count),
                                backgroundColor: 'rgba(5, 150, 105, 0.5)',
                                borderColor: '#059669',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            indexAxis: 'y',
                            scales: {
                                x: { title: { display: true, text: 'Count' } },
                                y: { title: { display: true, text: 'Application Number Range' } }
                            },
                            plugins: { legend: { display: false } }
                        }
                    });
                }
            }
            
            // Analytics computation functions
            function computeMonthly(rows) {
                var byMonth = {};
                rows.forEach(function(r) {
                    if (r._placeholder) return;
                    var d = r._dateObj || new Date(r.date);
                    var month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                    if (!byMonth[month]) byMonth[month] = { total: 0, approved: 0, rejected: 0 };
                    byMonth[month].total++;
                    if (r._status === 'accepted') byMonth[month].approved++;
                    else if (r._status === 'rejected') byMonth[month].rejected++;
                });
                return Object.keys(byMonth).sort().map(function(m) {
                    var d = byMonth[m];
                    return { month: m, total: d.total, approved: d.approved, rejected: d.rejected, rate: d.total ? (d.approved / d.total * 100).toFixed(1) : 0 };
                });
            }
            
            function computeRolling30(rows) {
                var real = rows.filter(function(r) { return !r._placeholder; });
                var byDate = {};
                real.forEach(function(r) {
                    if (!byDate[r.date]) byDate[r.date] = { total: 0, approved: 0 };
                    byDate[r.date].total++;
                    if (r._status === 'accepted') byDate[r.date].approved++;
                });
                var dates = Object.keys(byDate).sort();
                var result = [];
                for (var i = 0; i < dates.length; i++) {
                    var start = Math.max(0, i - 29);
                    var window = dates.slice(start, i + 1);
                    var total = 0, approved = 0;
                    window.forEach(function(d) {
                        total += byDate[d].total;
                        approved += byDate[d].approved;
                    });
                    result.push({ date: dates[i], rate: total ? (approved / total * 100).toFixed(1) : 0, total: total });
                }
                return result;
            }
            
            function computeDailyDelta(rows) {
                var real = rows.filter(function(r) { return !r._placeholder; });
                var byDate = {};
                real.forEach(function(r) {
                    if (!byDate[r.date]) byDate[r.date] = { total: 0, approved: 0 };
                    byDate[r.date].total++;
                    if (r._status === 'accepted') byDate[r.date].approved++;
                });
                var dates = Object.keys(byDate).sort();
                var result = [];
                for (var i = 1; i < dates.length; i++) {
                    var today = byDate[dates[i]];
                    var yesterday = byDate[dates[i - 1]];
                    if (yesterday) {
                        result.push({
                            date: dates[i],
                            volume: today.total - yesterday.total,
                            approved: today.approved - (yesterday.approved || 0)
                        });
                    }
                }
                return result;
            }
            
            function computeQueueDensity(rows) {
                var real = rows.filter(function(r) { return !r._placeholder; });
                var nums = real.map(function(r) { return parseInt(r.number, 10); }).sort(function(a, b) { return a - b; });
                if (!nums.length) return { bins: [] };
                
                var min = nums[0], max = nums[nums.length - 1];
                var binCount = 10;
                var binSize = Math.ceil((max - min + 1) / binCount);
                var bins = [];
                
                for (var i = 0; i < binCount; i++) {
                    var binMin = min + i * binSize;
                    var binMax = Math.min(min + (i + 1) * binSize - 1, max);
                    var count = nums.filter(function(n) { return n >= binMin && n <= binMax; }).length;
                    bins.push({
                        label: binMin.toLocaleString() + ' - ' + binMax.toLocaleString(),
                        count: count,
                        min: binMin,
                        max: binMax
                    });
                }
                return { bins: bins };
            }

            // 1G page timeline form (separate from the embassy-visa one).
            function renderG1TimelineForm() {
                return '<form class="card" id="time-form-1g" name="timelines-1g" novalidate style="max-width:100%;">' +
                    TIMELINES_1G_FORM_HTML +
                '</form>';
            }

            // Community timeline submissions (item 6): applied -> decided
            // dates per tracker, synced nightly into data/community_timelines.json.
            const TIMELINES_FORM_HTML =
            '<input type="hidden" name="form-name" value="timelines-visa" />' +
            '<h3 class="readme-title" style="margin-top:0;">Share your timeline</h3>' +
            '<p class="note2">Embassy visa only - applied and decided dates from the New Delhi list. Published anonymously in aggregate.</p>' +
            '<input type="hidden" name="tracker" value="visa" />' +
            '<p><label>Applied on <input type="date" id="time-applied" name="applied" data-calendar /></label></p>' +
            '<p><label>Decided on <input type="date" id="time-decided" name="decided" data-calendar /></label></p>' +
            '<p><label>Outcome <select id="time-outcome" name="outcome" aria-label="Outcome" data-glide data-glide-size="sm" data-glide-menu-width="150"><option value="granted">Granted</option><option value="refused">Refused</option></select></label></p>' +
            '<button class="btn" type="submit" id="time-submit">Share Timeline</button>' +
            '<div class="note" id="time-status" aria-live="polite"></div>';

            // 1G-specific timeline form (for the 1G page).
            const TIMELINES_1G_FORM_HTML =
                '<input type="hidden" name="form-name" value="timelines-1g" />' +
                '<h3 class="readme-title" style="margin-top:0;">Share your 1G timeline</h3>' +
                '<p class="note2">Stamp 1G renewals only - when did you apply, and when was it decided? Published anonymously in aggregate.</p>' +
                '<input type="hidden" name="tracker" value="1g" />' +
                '<p><label>Applied on <input type="date" id="time-applied-1g" name="applied" data-calendar /></label></p>' +
                '<p><label>Decided on <input type="date" id="time-decided-1g" name="decided" data-calendar /></label></p>' +
                '<p><label>Outcome <select id="time-outcome-1g" name="outcome" aria-label="Outcome" data-glide data-glide-size="sm" data-glide-menu-width="150"><option value="granted">Granted</option><option value="refused">Refused</option></select></label></p>' +
                '<button class="btn" type="submit" id="time-submit-1g">Share Timeline</button>' +
                '<div class="note" id="time-status-1g" aria-live="polite"></div>';

            const ALERT_FORM_HTML =
                '<input type="hidden" name="form-name" value="alert-subscribe" />' +
                '<h3 class="readme-title" style="margin-top:0;">Get Decision Alerts</h3>' +
                '<p class="note2">Enter your email and application number. We will email you the moment a decision is published.</p>' +
                '<input type="hidden" name="bot-field" autocomplete="off" tabindex="-1" />' +
                '<p><label>Email <input type="email" name="email" required placeholder="you@example.com" /></label></p>' +
                '<p><label>Application Number <input type="text" name="application_number" required placeholder="12345678" pattern="\\d{8}" /></label></p>' +
                '<p><label>Visa Office <select name="embassy" required>' +
                    '<option value="new-delhi">🇮🇳 New Delhi (India, Bangladesh, Nepal, Sri Lanka)</option>' +
                    '<option value="beijing">🇨🇳 Beijing (China, Hong Kong, Macau, Mongolia)</option>' +
                    '<option value="dublin">🇮🇪 Dublin (Pakistan + transfers)</option>' +
                    '<option value="abu-dhabi">🇦🇪 Abu Dhabi (UAE, Qatar, Gulf, North Africa)</option>' +
                    '<option value="abuja">🇳🇬 Abuja (Nigeria, Ghana, Côte d\'Ivoire, Senegal)</option>' +
                    '<option value="ankara">🇹🇷 Ankara (Türkiye, Azerbaijan, Saudi Arabia residents)</option>' +
                '</select></label></p>' +
                '<button class="btn" type="submit" id="alert-submit">Enable Alerts</button>' +
                '<button class="btn" type="button" id="telegram-alert-btn" style="margin-top:8px;background:#229ED9;border-color:#229ED9;color:#fff;">Get alerts on Telegram</button>' +
                '<p class="note2" style="margin-top:6px;">Free and no email needed. Opens the Telegram bot with your application ready to link.</p>' +
                '<div class="note" id="alert-status" aria-live="polite"></div>';

            async function submitTimeline(is1G) {
                // Explicit flag from the submit listener: true for the 1G
                // page form, false for the embassy-visa form on Suggestions.
                // Falls back to DOM detection so older in-flight handlers
                // still resolve to the visa form.
                if (typeof is1G === 'undefined' || is1G === null) {
                    is1G = document.getElementById('time-applied-1g') !== null;
                }
                is1G = !!is1G;
                const appliedEl = document.getElementById(is1G ? 'time-applied-1g' : 'time-applied');
                const decidedEl = document.getElementById(is1G ? 'time-decided-1g' : 'time-decided');
                const outcomeEl = document.getElementById(is1G ? 'time-outcome-1g' : 'time-outcome');
                const status = document.getElementById(is1G ? 'time-status-1g' : 'time-status');
                const btn = document.getElementById(is1G ? 'time-submit-1g' : 'time-submit');
                const formId = is1G ? 'time-form-1g' : 'time-form';
                if (!appliedEl || !decidedEl || !outcomeEl || !status || !btn) return;

                const applied = appliedEl.value, decided = decidedEl.value;
                const today = new Date().toISOString().slice(0, 10);
                if (!applied || !decided) {
                    status.textContent = 'Please fill in both dates.';
                    (applied ? decidedEl : appliedEl).focus();
                    return;
                }
                if (applied > decided || decided > today || applied < '2020-01-01') {
                    status.textContent = 'Those dates don\u2019t look right - applied must come first and decided can\u2019t be in the future.';
                    return;
                }
                btn.disabled = true;
                status.textContent = 'Submitting\u2026';
                const startedAt = Date.now();
                try {
                    const body = new URLSearchParams({
                        'form-name': is1G ? 'timelines-1g' : 'timelines-visa',
                        'bot-field': '',
                        tracker: is1G ? '1g' : 'visa',
                        applied: applied,
                        decided: decided,
                        outcome: outcomeEl.value
                    });
                    const res = await fetch(window.location.pathname, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body.toString()
                    });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const remaining = MIN_SUBMIT_MS - (Date.now() - startedAt);
                    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
                    const form = document.getElementById(formId);
                    if (form) form.innerHTML =
                        '<div class="sugg-success" role="status">' +
                        '<div class="sugg-success-title">Thanks - timeline shared!</div>' +
                        '<div class="sugg-success-text">It appears in the community stats after the nightly sync.</div>' +
                        '<button class="btn" type="button" id="' + (is1G ? 'time-again-1g' : 'time-again') + '">Share another</button></div>';
                    const again = document.getElementById(is1G ? 'time-again-1g' : 'time-again');
                    if (again) again.addEventListener('click', function() {
                        const f = document.getElementById(formId);
                        if (!f) return;
                        f.innerHTML = is1G ? TIMELINES_1G_FORM_HTML : TIMELINES_FORM_HTML;
                        f.addEventListener('submit', function(e) { e.preventDefault(); submitTimeline(is1G); });
                    });
                } catch (err) {
                    status.textContent = 'Could not submit. Try again.';
                } finally {
                    btn.disabled = false;
                }
            }

            async function submitAlert() {
                const form = document.getElementById('alert-form');
                if (!form) return;
                const statusEl = document.getElementById('alert-status');
                const btn = document.getElementById('alert-submit');
                const emailEl = form.querySelector('input[name="email"]');
                const appNumEl = form.querySelector('input[name="application_number"]');
                const embassyEl = form.querySelector('select[name="embassy"]');

                const email = emailEl.value.trim().toLowerCase();
                const applicationNumber = appNumEl.value.trim();
                const embassy = embassyEl.value;

                if (!email.includes('@')) {
                    statusEl.textContent = 'Please enter a valid email address.';
                    statusEl.style.color = 'var(--red)';
                    emailEl.focus();
                    return;
                }
                if (!/^\d{8}$/.test(applicationNumber)) {
                    statusEl.textContent = 'Please enter a valid 8-digit application number.';
                    statusEl.style.color = 'var(--red)';
                    appNumEl.focus();
                    return;
                }

                btn.disabled = true;
                statusEl.textContent = 'Subscribing…';
                statusEl.style.color = 'var(--ink)';

                try {
                    const fd = new FormData();
                    fd.append('form-name', 'alert-subscribe');
                    fd.append('email', email);
                    fd.append('application_number', applicationNumber);
                    fd.append('embassy', embassy);
                    fd.append('bot-field', '');

                    const res = await fetch('/api/subscribe', { method: 'POST', body: fd });
                    const data = await res.json();

                    if (res.ok) {
                        statusEl.textContent = '✅ Verification email sent! Check your inbox.';
                        statusEl.style.color = 'var(--green)';
                        markActivation('alerts');
                        trackConversion('alert_email_submitted', 'suggestions');
                        form.reset();
                    } else {
                        statusEl.textContent = '❌ ' + (data.error || 'Failed to subscribe');
                        statusEl.style.color = 'var(--red)';
                    }
                } catch (err) {
                    statusEl.textContent = '❌ Network error. Please try again.';
                    statusEl.style.color = 'var(--red)';
                } finally {
                    btn.disabled = false;
                }
            }

            function showSuggestionSuccess(name) {
                const form = document.getElementById('sugg-form');
                if (!form) return;
                // Sparkle burst: dots + diamonds radiating from the checkmark.
                // Each spark gets a direction vector, size, and stagger delay.
                let sparks = '';
                const SPARK_COUNT = 16;
                for (let i = 0; i < SPARK_COUNT; i++) {
                    const ang = (i / SPARK_COUNT) * Math.PI * 2;
                    const dist = 34 + (i % 3) * 9;                    // varied reach
                    const tx = Math.round(Math.cos(ang) * dist);
                    const ty = Math.round(Math.sin(ang) * dist);
                    const size = 5 + (i % 3) * 2;                      // varied size
                    const delay = 0.5 + (i % 5) * 0.045;               // after check draws
                    const cls = i % 3 === 2 ? 'diamond' : 'dot';
                    sparks += '<span class="' + cls + '" style="width:' + size + 'px;height:' + size + 'px;--tx:' + tx + 'px;--ty:' + ty + 'px;--d:' + delay.toFixed(3) + 's;"></span>';
                }
                form.innerHTML =
                    '<div class="sugg-success" role="status">' +
                        '<div class="check-wrap">' +
                            '<div class="burst" aria-hidden="true">' + sparks + '</div>' +
                            '<svg class="check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M14 27l8 8 16-16"/></svg>' +
                        '</div>' +
                        '<div class="sugg-success-title">Thanks, ' + escapeHtml(name) + '!</div>' +
                        '<div class="sugg-success-text">Your suggestion is in. I\'ll read it and get back to you asap.</div>' +
                        '<button class="btn" type="button" id="sugg-again">Send another</button>' +
                    '</div>';
                const again = document.getElementById('sugg-again');
                if (again) again.addEventListener('click', function() {
                    // Restore the form body and re-bind the submit handler
                    // (wireTabListeners won't run again until the next tab switch).
                    form.innerHTML = SUGG_FORM_HTML;
                    form.addEventListener('submit', function(e) { e.preventDefault(); submitSuggestion(); });
                });
            }

            async function submitSuggestion() {
                const nameEl = document.getElementById('sugg-name');
                const suggEl = document.getElementById('sugg-text');
                const name = nameEl.value.trim();
                const suggestion = suggEl.value.trim();
                const status = document.getElementById('sugg-status');
                const btn = document.getElementById('sugg-submit');
                if (!name || !suggestion) {
                    status.textContent = 'Please fill in both fields.';
                    (name ? suggEl : nameEl).focus();
                    return;
                }
                btn.disabled = true;
                status.textContent = 'Submitting…';
                const startedAt = Date.now();
                try {
                    // POST straight to the site itself - the Worker stores any
                    // form post carrying form-name=suggestions in D1.
                    const body = new URLSearchParams({
                        'form-name': 'suggestions',
                        'bot-field': '',          // honeypot must stay empty
                        name: name,
                        suggestion: suggestion
                    });
                    const res = await fetch(window.location.pathname, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body.toString()
                    });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    // Hold the "Submitting…" state until at least MIN_SUBMIT_MS
                    // has elapsed since it appeared, so a fast response still
                    // reads as a real submission. Slow requests aren't delayed.
                    const remaining = MIN_SUBMIT_MS - (Date.now() - startedAt);
                    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
                    showSuggestionSuccess(name);
                } catch (err) {
                    status.textContent = 'Could not submit. Try again.';
                } finally {
                    btn.disabled = false;
                }
            }

            
            // Keep the browser chrome in sync with the theme: native controls
            // (date picker, inputs, scrollbars) and the browser UI color.
            function applyChrome() {
                document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
                const meta = document.querySelector('meta[name="theme-color"]');
                if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#ffffff');
            }

            function toggleTheme() {
                theme = theme === 'light' ? 'dark' : 'light';
                localStorage.setItem('visa-theme', theme);
                root.setAttribute('data-theme', theme);
                // The switch reads aria-checked, so the thumb follows the
                // stored theme without rebuilding the header.
                const toggle = document.getElementById('theme-toggle');
                if (toggle) toggle.setAttribute('aria-checked', String(theme === 'dark'));
                // Theme switch is instant via CSS variables; the sun/moon SVG
                // icon swaps via CSS on [data-theme], so no JS or DOM rebuild.
                applyChrome();
            }

            // ===== tracker landing + Stamp 1G =====
            // Top-level view switcher. 'home' is the landing screen with two
            // tracker cards; 'visa' is the existing embassy-decisions tracker
            // (untouched below); '1g' is the Stamp 1G processing-date tracker
            // fed by data/stamp_1g.json (written daily by track_1g.py).
            const THEME_BTN_HTML = '<button class="theme-switch" id="theme-toggle" role="switch" aria-checked="' + (theme === 'dark') + '" aria-label="Dark mode" title="Dark mode" data-squish-switch data-ss-bare data-ss-size="sm">' +
                '<svg class="icon-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>' +
                '<svg class="icon-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg></button>';
            const BACK_BTN_HTML = '<button type="button" class="back-btn" id="back-btn"><i data-lucide="arrow-left"></i> All trackers</button>';

            function setTracker(id, opts) {
                activeTracker = id;
                if (!(opts && opts.noUrl)) syncUrl('push');
                render();
            }

            function wireChrome() {
                const themeToggle = document.getElementById('theme-toggle');
                if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
                const backBtn = document.getElementById('back-btn');
                if (backBtn) backBtn.addEventListener('click', function() { setTracker('home'); });
                const accountBtn = document.getElementById('account-btn');
                if (accountBtn) accountBtn.addEventListener('click', openAccountModal);
                const signoutBtn = document.getElementById('signout-btn');
                if (signoutBtn) signoutBtn.addEventListener('click', signOut);
                // Modal form submit handlers (delegated, survives re-renders).
                var signinForm = document.getElementById('account-form-signin');
                if (signinForm && !signinForm._wired) {
                    signinForm._wired = true;
                    signinForm.addEventListener('submit', handleAccountForm);
                }
                var regForm = document.getElementById('account-form-register');
                if (regForm && !regForm._wired) {
                    regForm._wired = true;
                    regForm.addEventListener('submit', handleAccountForm);
                }
                // Tab buttons inside the modal.
                var tSignin = document.getElementById('account-tab-signin');
                var tRegister = document.getElementById('account-tab-register');
                if (tSignin) tSignin.addEventListener('click', function() { showAccountTab('signin'); });
                if (tRegister) tRegister.addEventListener('click', function() { showAccountTab('register'); });
            }

            // First-paint hero reveal shared by landing/1G pages. The visa
            // path owns morphHero()'s once-per-load guard, so when these pages
            // render after it the hero must be shown directly instead.
            function showHero() {
                var hero = document.getElementById('hero');
                if (!hero) return;
                if (window._heroHasRendered) hero.style.opacity = '1';
                else morphHero();

            // Initialize i18n
            if (typeof initLanguage === 'function') {
                initLanguage();
                translatePage();
                // Create language selector after i18n module loads
                var langBtn = document.querySelector('.lang-btn');
                if (langBtn && typeof createLanguageSelector === 'function') {
                    langBtn.outerHTML = createLanguageSelector();
                }
            }
            // Language selector dropdown toggle
            document.addEventListener('click', function(e) {
                var btn = e.target.closest('.lang-btn');
                if (btn) {
                    var dropdown = btn.nextElementSibling;
                    if (dropdown && dropdown.classList.contains('lang-dropdown')) {
                        var isOpen = dropdown.style.display === 'block';
                        document.querySelectorAll('.lang-dropdown').forEach(d => d.style.display = 'none');
                        dropdown.style.display = isOpen ? 'none' : 'block';
                    }
                } else if (!e.target.closest('.lang-dropdown')) {
                    document.querySelectorAll('.lang-dropdown').forEach(d => d.style.display = 'none');
                }
                var langItem = e.target.closest('.lang-dropdown li[data-lang]');
                if (langItem) {
                    var lang = langItem.getAttribute('data-lang');
                    if (typeof setLanguage === 'function' && setLanguage(lang)) {
                        translatePage();
                    }
                    langItem.closest('.lang-dropdown').style.display = 'none';
                }
            });

            }

            // ---- Stamp 1G data + projections ----
            let g1Cache = null;
            let g1ActiveRows = [];
            let g1FetchedAt = null;

            async function loadG1Data() {
                if (g1Cache) return g1Cache;
                try {
                    // no-store so the daily cron's new observation shows up
                    // without waiting for CDN/browser cache to expire.
                    const res = await fetch('data/stamp_1g.json', { cache: 'no-store' });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const raw = await res.json();
                    g1Cache = (Array.isArray(raw) ? raw : [])
                        .filter(function(r) { return r && r.run_date && r.processing_date; })
                        .map(function(r) {
                            return {
                                run_date: String(r.run_date).slice(0, 10),
                                run_time: String(r.run_time || ''),
                                category: String(r.category || '1G'),
                                processing_date: String(r.processing_date).slice(0, 10),
                                lag_days: +r.lag_days || 0,
                                lag_weeks: +r.lag_weeks || 0
                            };
                        })
                        .sort(function(a, b) { return a.run_date.localeCompare(b.run_date); });
                    g1FetchedAt = Date.now();
                } catch (e) {
                    console.warn('loadG1Data failed:', e);
                    if (g1Cache === null) g1Cache = [];
                }
                return g1Cache;
            }

            // Employment permits + community timelines share the 1G row shape
            // ({run_date, category, processing_date, lag_days}), so the same
            // projection/chart code renders all three trackers.
            let permitsCache = null;
            async function loadPermitsData() {
                if (permitsCache) return permitsCache;
                try {
                    const res = await fetch('data/work_permits.json', { cache: 'no-store' });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const raw = await res.json();
                    permitsCache = (Array.isArray(raw) ? raw : [])
                        .filter(function(r) { return r && r.run_date && r.processing_date; })
                        .map(function(r) {
                            return {
                                run_date: String(r.run_date).slice(0, 10),
                                run_time: String(r.run_time || ''),
                                category: String(r.category || 'Unknown'),
                                processing_date: String(r.processing_date).slice(0, 10),
                                lag_days: +r.lag_days || 0,
                                lag_weeks: +r.lag_weeks || 0
                            };
                        })
                        .sort(function(a, b) { return a.run_date.localeCompare(b.run_date); });
                } catch (e) {
                    console.warn('loadPermitsData failed:', e);
                    if (permitsCache === null) permitsCache = [];
                }
                return permitsCache;
            }

            let communityCache = null;
            async function loadCommunity() {
                if (communityCache) return communityCache;
                try {
                    const res = await fetch('data/community_timelines.json', { cache: 'no-store' });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const raw = await res.json();
                    communityCache = Array.isArray(raw) ? raw : [];
                } catch (e) {
                    if (communityCache === null) communityCache = [];
                }
                return communityCache;
            }

            function communityStats(rows, tracker) {
                var waits = (rows || []).map(function(r) {
                    if (!r || r.tracker !== tracker) return null;
                    var a = Date.parse(r.applied), b = Date.parse(r.decided);
                    return (isFinite(a) && isFinite(b) && b >= a) ? (b - a) / 86400000 : null;
                }).filter(function(v) { return v !== null; }).sort(function(a, b) { return a - b; });
                if (!waits.length) return null;
                var mid = Math.floor(waits.length / 2);
                return {
                    n: waits.length,
                    median: waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2
                };
            }

            // Distinct stamp/permit categories in first-seen order.
            function g1Categories(rows) {
                var seen = {}, out = [];
                (rows || []).forEach(function(r) {
                    var c = r.category || '1G';
                    if (!seen[c]) { seen[c] = 1; out.push(c); }
                });
                return out;
            }

            function g1RowsFor(rows, cat) {
                return (rows || []).filter(function(r) { return (r.category || '1G') === cat; });
            }

            function g1StoredCategory(rows) {
                var cats = g1Categories(rows);
                if (!cats.length) return '1G';
                try {
                    var saved = localStorage.getItem('stamp1g-category') || '';
                    if (saved && cats.indexOf(saved) !== -1) return saved;
                } catch (e) { /* private mode */ }
                return cats.indexOf('1G') !== -1 ? '1G' : cats[0];
            }

            // ---- watched application numbers (item 5) ----
            // localStorage list of normalized IRL queries; checked against
            // fresh data on every home paint so a watched decision surfaces
            // as a banner the moment it lands.
            function getWatchlist() {
                try {
                    var raw = JSON.parse(localStorage.getItem('visa-watchlist') || '[]');
                    return Array.isArray(raw) ? raw.filter(function(x) {
                        return typeof x === 'string' && x;
                    }).slice(0, 10) : [];
                } catch (e) { return []; }
            }
            function saveWatchlist(list) {
                try { localStorage.setItem('visa-watchlist', JSON.stringify(list.slice(0, 10))); }
                catch (e) { /* private mode */ }
            }
            function checkWatchlist(rows, list) {
                var hits = [];
                (list || []).forEach(function(term) {
                    var match = (rows || []).find(function(r) {
                        return !r._placeholder && normalizeIRL(r.irl).indexOf(term) !== -1;
                    });
                    if (match) hits.push({ term: term, row: match });
                });
                return hits;
            }

            // ---- IRP expiry countdown (item 2) ----
            // Renewal window opens 12 weeks (84 days) before expiry.
            function irpWindowHTML(expiryISO, todayISO) {
                if (!expiryISO) return '';
                var ms = Date.parse(expiryISO + 'T00:00:00') - Date.parse(todayISO + 'T00:00:00');
                if (!isFinite(ms)) return '';
                var left = Math.round(ms / 86400000);
                if (left < 0) {
                    return 'Expired ' + Math.abs(left) + ' days ago - renew now if you haven\u2019t.';
                }
                if (left <= 84) {
                    return '12-week window is <strong>OPEN</strong> - apply now (' + left + ' days left).';
                }
                var opens = new Date(Date.parse(expiryISO + 'T00:00:00') - 84 * 86400000);
                var label = opens.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                return '12-week window opens <strong>' + label + '</strong> (' + left + ' days left).';
            }

            // Lightweight visa total for the landing card: ?action=count reads
            // no row data server-side, so this stays fast at tens of thousands
            // of rows. Falls back to the full fetch (older backend, or the
            // local mock which serves the same file for every action).
            let visaCountCache = null;
            async function loadVisaCount() {                if (visaCountCache !== null) return visaCountCache;
                try {
                    const res = await fetch(VISA_META_URL, { cache: 'no-store' });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const m = await res.json();
                    if (!m || typeof m.sheetRows !== 'number') throw new Error('bad meta');
                    visaCountCache = m.sheetRows;
                } catch (e) {
                    const rows = await loadData();
                    visaCountCache = (rows || []).length;
                }
                return visaCountCache;
            }

            function g1ToDay(iso) {
                var p = String(iso).split('-');
                return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
            }
            function g1FromDay(n) {
                return new Date(Math.round(n) * 86400000).toISOString().slice(0, 10);
            }
            function g1LinReg(pts) {
                var n = pts.length, i, sx = 0, sy = 0;
                for (i = 0; i < n; i++) { sx += pts[i].x; sy += pts[i].y; }
                var mx = sx / n, my = sy / n, sxx = 0, sxy = 0;
                for (i = 0; i < n; i++) { sxx += (pts[i].x - mx) * (pts[i].x - mx); sxy += (pts[i].x - mx) * (pts[i].y - my); }
                if (!sxx) return null;
                var slope = sxy / sxx;
                return { slope: slope, intercept: my - slope * mx };
            }

            // Advancement-rate + ETA projections from the JSON history.
            // Model: ordinary least-squares fit of processing_date over
            // run_date (slope = ISD days advanced per calendar day). Overall
            // fit uses every observation; recent fit uses the last 10.
            function computeG1Projections(rows) {
                if (!rows || !rows.length) return { ok: false, count: 0 };
                if (rows.length < 2) {
                    // Thin history: assume the queue keeps a 1:1 pace
                    // (constant lag) rather than inventing a trend from a
                    // single point. Recomputed properly once history grows.
                    var only = rows[0];
                    var todayStr0 = new Date().toISOString().slice(0, 10);
                    var remaining0 = g1ToDay(todayStr0) - g1ToDay(only.processing_date);
                    var eta0 = Math.max(0, Math.ceil(remaining0));
                    return {
                        ok: true, fallback: true, count: 1,
                        first: only, latest: only, todayStr: todayStr0,
                        rateWeek: 7, recentWeek: 7,
                        remaining: remaining0, etaDays: eta0,
                        etaDate: g1FromDay(g1ToDay(todayStr0) + eta0),
                        ahead: [14, 28, 56, 84].map(function(d) {
                            return { days: d, proc: g1FromDay(g1ToDay(only.processing_date) + d) };
                        }),
                        lagDelta: 0
                    };
                }
                var pts = rows.map(function(r) { return { x: g1ToDay(r.run_date), y: g1ToDay(r.processing_date) }; });
                var all = g1LinReg(pts);
                if (!all) return { ok: false, count: rows.length };
                var recentPts = pts.slice(-Math.min(10, pts.length));
                var recent = g1LinReg(recentPts) || all;
                var latest = rows[rows.length - 1];
                var first = rows[0];
                var todayStr = new Date().toISOString().slice(0, 10);
                var remaining = g1ToDay(todayStr) - g1ToDay(latest.processing_date);
                var slope = recent.slope;
                // Slope <= ~0 means stalled (or regressing) - no finite ETA.
                var etaDays = slope > 0.005 ? Math.max(0, Math.ceil(remaining / slope)) : null;
                var ahead = [14, 28, 56, 84].map(function(d) {
                    return { days: d, proc: g1FromDay(g1ToDay(latest.processing_date) + slope * d) };
                });
                return {
                    ok: true,
                    count: rows.length,
                    first: first,
                    latest: latest,
                    todayStr: todayStr,
                    rateWeek: all.slope * 7,
                    recentWeek: slope * 7,
                    remaining: remaining,
                    etaDays: etaDays,
                    etaDate: etaDays === null ? null : g1FromDay(g1ToDay(todayStr) + etaDays),
                    ahead: ahead,
                    lagDelta: latest.lag_days - first.lag_days
                };
            }

            function fmtG1Date(iso) {
                var p = String(iso).split('-');
                var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
                return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
            }
            // Mean Gregorian month - good enough for a "how long" readout.
            function fmtLagMonths(days) { return (days / 30.44).toFixed(1); }

            // ---- 1G personal estimator ----
            // The user's application date + mode persist in localStorage so the
            // tentative outcome recomputes from the LATEST cron row on every
            // load - the estimate tracks the moving lag automatically.
            function g1StoredDate() {
                try { return (localStorage.getItem('stamp1g-apply-date') || '').slice(0, 10); }
                catch (e) { return ''; }
            }
            function g1StoredMode() {
                try { return localStorage.getItem('stamp1g-apply-mode') === 'plan' ? 'plan' : 'applied'; }
                catch (e) { return 'applied'; }
            }
            function g1SaveEstimate() {
                try {
                    var input = document.getElementById('g1-apply-date');
                    var v = input ? input.value : '';
                    if (v) localStorage.setItem('stamp1g-apply-date', v);
                    else localStorage.removeItem('stamp1g-apply-date');
                } catch (e) { /* private mode */ }
            }

            function g1TodayLocal() {
                var d = new Date();
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
                    '-' + String(d.getDate()).padStart(2, '0');
            }
            function g1ShiftLocal(iso, delta) {
                var p = String(iso).split('-');
                var d = new Date(+p[0], +p[1] - 1, +p[2]);
                d.setDate(d.getDate() + delta);
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
                    '-' + String(d.getDate()).padStart(2, '0');
            }
            // "plan" allows future dates only, "applied" today-or-past. Native
            // min/max grey out invalid days in the picker; a stored value left
            // invalid by a mode switch is cleared so the estimate resets.
            function applyG1DateBounds() {
                var input = document.getElementById('g1-apply-date');
                if (!input) return;
                var today = g1TodayLocal();
                if (g1StoredMode() === 'plan') {
                    input.min = g1ShiftLocal(today, 1);
                    input.removeAttribute('max');
                    if (input.value && input.value <= today) { input.value = ''; g1SaveEstimate(); }
                } else {
                    input.max = today;
                    input.removeAttribute('min');
                    if (input.value && input.value > today) { input.value = ''; g1SaveEstimate(); }
                }
            }

            function paintG1Estimate() {
                var box = document.getElementById('g1-estimate');
                if (!box) return;
                var input = document.getElementById('g1-apply-date');
                var entered = input ? input.value : '';
                var rows = g1ActiveRows.length ? g1ActiveRows : (g1Cache || []);
                if (!rows.length) {
                    box.innerHTML = '<span class="note2">Estimates appear once the cron records its first observation.</span>';
                    return;
                }
                if (!entered) {
                    box.innerHTML = '<span class="note2">Enter your date above - your estimate appears here and refreshes with every cron run.</span>';
                    return;
                }
                var latest = rows[rows.length - 1];
                var mode = g1StoredMode();
                var when = mode === 'plan' ? 'Apply on ' + fmtG1Date(entered) : 'Applied ' + fmtG1Date(entered);
                if (entered <= latest.processing_date) {
                    box.innerHTML = '<div class="g1-estimate">' + when +
                        ' - ISD is already processing <strong>' + fmtG1Date(latest.processing_date) +
                        '</strong>, past your date. Your outcome may already be decided.</div>';
                    return;
                }
                var buffer = g1StoredBuffer();
                var tentative = g1FromDay(g1ToDay(entered) + latest.lag_days + buffer * 7);
                var inDays = Math.round(g1ToDay(tentative) - g1ToDay(new Date().toISOString().slice(0, 10)));
                box.innerHTML = '<div class="g1-estimate">' + when +
                    ' \u2192 tentative outcome around <strong>' + fmtG1Date(tentative) + '</strong> (in ~' + inDays + ' days)' +
                    ' <span class="pill blue">current lag ' + latest.lag_days + 'd (~' + fmtLagMonths(latest.lag_days) + ' mo)</span>' +
                    (buffer ? ' <span class="pill">+' + buffer + 'w buffer</span>' : '') + '</div>' +
                    '<div class="note2" style="margin-top:6px;">Your date + the current lag' +
                    (buffer ? ' + your ' + buffer + '-week buffer' : '') +
                    ', recalculated automatically when new observations arrive.</div>';
            }

            // A buffer is the one number a visa applicant adds for themselves: the
            // lag is a mean, so padding the estimate by 0–12 weeks is a choice,
            // not a rule. It persists beside the date and never changes the data.
            function g1StoredBuffer() {
                try {
                    var n = parseInt(localStorage.getItem('stamp1g-buffer'), 10);
                    return isFinite(n) ? Math.max(0, Math.min(12, n)) : 0;
                } catch (e) { return 0; }
            }
            function paintG1Buffer() {
                var host = document.getElementById('g1-buffer');
                if (!host || !window.Stepper || Stepper.get(host) !== null) return;
                Stepper.mount(host, {
                    value: g1StoredBuffer(), min: 0, max: 12, step: 1,
                    label: 'Buffer', unit: 'week', size: 'sm',
                    onChange: function (n) {
                        try { localStorage.setItem('stamp1g-buffer', String(n)); } catch (e) { /* private mode */ }
                        paintG1Estimate();
                    }
                });
            }

            function g1StoredExpiry() {
                try { return (localStorage.getItem('stamp1g-expiry') || '').slice(0, 10); }
                catch (e) { return ''; }
            }

            function paintG1Expiry() {
                var box = document.getElementById('g1-expiry');
                if (!box) return;
                var input = document.getElementById('g1-expiry-date');
                var expiry = input ? input.value : '';
                if (!expiry) {
                    box.innerHTML = '<span class="note2">Add your IRP expiry above for a renewal countdown.</span>';
                    return;
                }
                var today = new Date().toISOString().slice(0, 10);
                box.innerHTML = '<div class="g1-estimate">' + irpWindowHTML(expiry, today) + '</div>';
            }

            // Processing-date advancement line: x = observation date,
            // y = ISD processing date. Dots + first/last labels, no deps.
            // Weekly-average lag bars: one bar per ISO week (Mon-Sun) showing
            // the mean lag of that week's observations. Weekly bins absorb the
            // day-to-day sawtooth (lag climbs while ISD stalls, then drops
            // when it jumps) and never interpolate across archive gaps - a
            // week with no observations simply has no bar.
            function g1WeekKey(iso) {
                var p = String(iso).split('-');
                var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
                var mon = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
                return mon.toISOString().slice(0, 10);
            }
            /* Average lag per week, as the design system's analytics-chart.
               The grouped SVG this replaces drew bars, a regression line and a
               marker for the visitor's saved week; the bars are now a line with
               one tooltip per week (observations included), which is what the
               weekly means actually are - a continuous series, not categories. */
            function renderG1LagChart(rows) {
                var host = document.getElementById('g1-lag');
                if (!host) return;
                
                var weeks = [];
                var byWeek = {};
                rows.forEach(function(r) {
                    var k = g1WeekKey(r.run_date);
                    if (!byWeek[k]) { byWeek[k] = { sum: 0, n: 0 }; weeks.push(k); }
                    byWeek[k].sum += r.lag_days;
                    byWeek[k].n += 1;
                });
                var points = weeks.map(function(k) {
                    var p = String(k).split('-');
                    var label = (+p[2]) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1] - 1];
                    return { label: label, value: +(byWeek[k].sum / byWeek[k].n).toFixed(1), note: byWeek[k].n + ' obs' };
                });
                
                function draw() {
                    if (window.AnalyticsChart) {
                        AnalyticsChart.render(host, points, {
                            label: 'average lag',
                            format: function(v) { return v.toFixed(1) + ' days'; }
                        });
                    } else {
                        // analytics-chart.js loads with defer; wait for it
                        setTimeout(draw, 50);
                    }
                }
                draw();
            }

            function renderG1Layout(rows, cats, activeCat) {
                cats = cats && cats.length ? cats : ['1G'];
                activeCat = activeCat || '1G';
                var head = BACK_BTN_HTML +
                    '<div class="eyebrow">Ireland \u00b7 Immigration Service Delivery</div>' +
                    '<div class="titlerow"><h1>Stamp ' + escapeHtml(activeCat) + ' Tracker</h1>' +
                    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' + THEME_BTN_HTML + '</div></div>' +
                    '<div class="sub">' + (rows.length ? rows.length + ' observation' + (rows.length === 1 ? '' : 's') + ' on record' : 'Awaiting data') + '</div>';
                if (!rows.length) {
                    return head +
                        '<div class="empty">No observations recorded yet. The daily job writes to <code>data/stamp_1g.json</code> - check back after its first run.</div>';
                }
                var catPills = cats.length > 1
                    ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;" id="g1-cats" role="group" aria-label="Stamp category"' +
                      ' data-rubber-segment data-rs-key="g1-cats" data-rs-size="sm" data-rs-inset="0" data-rs-radius="999" data-rs-stretch="80" data-rs-squash="2">' +
                      cats.map(function(c) {
                          return '<button type="button" class="recent-chip mode-chip' + (c === activeCat ? ' active' : '') +
                              '" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (c === activeCat) + '">' + escapeHtml(c) + '</button>';
                      }).join('') + '</div>'
                    : '';
                var proj = computeG1Projections(rows);
                var latest = rows[rows.length - 1];
                var heroTitle = 'Processing ' + fmtG1Date(latest.processing_date) + '.';
                var heroSub = latest.lag_days + ' days (~' + fmtLagMonths(latest.lag_days) + ' mo) behind today' +
                    (proj.ok && proj.recentWeek !== null ? ', advancing ~' + proj.recentWeek.toFixed(1) + ' days/week.' : '.');
                var hero = '<div class="hero" id="hero" data-id="g1" style="opacity:0">' +
                    '<div class="hero-body"><div>' +
                    '<h2 class="hero-title">' + heroTitle + '</h2>' +
                    '<div class="hero-sub">' + heroSub + '</div>' +
                    '</div><div class="visual">' +
                    '<div class="ring"></div><div class="ring"></div><div class="ring"></div>' +
                    '<div class="ring-core">' + latest.lag_days + '</div>' +
                    '</div></div></div>';
                var cards = '<div class="cards">' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>ISD processing date</div><div class="value">' + fmtG1Date(latest.processing_date) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="hourglass"></i>Current lag</div><div class="value">' + latest.lag_days + ' days <span style="font-size:13px;font-weight:600;">(~' + fmtLagMonths(latest.lag_days) + ' mo)</span></div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="trending-up"></i>Advancement rate</div><div class="value">' +
                    (proj.ok ? proj.recentWeek.toFixed(1) + ' <span style="font-size:13px;font-weight:600;">days/week</span>' : '-') + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="flag"></i>ETA to today</div><div class="value">' +
                    (proj.ok && proj.etaDate ? fmtG1Date(proj.etaDate) + ' <span style="font-size:13px;font-weight:600;">(in ~' + proj.etaDays + 'd)</span>' : (proj.ok ? 'Stalled' : '-')) + '</div></div>' +
                    '</div>';
                var projHtml;
                if (!proj.ok) {
                    projHtml = '';
                } else {
                    var pace = proj.fallback ? 'Early estimate - only one observation so far; assuming the queue keeps a 1:1 pace until more history arrives.' :
                        proj.recentWeek >= 6.5 ? 'On pace - the queue is roughly keeping up with new applications.' :
                        proj.recentWeek > 0.5 ? 'Moving, but slower than real time - the backlog is growing.' :
                        'Stalled - the processing date is barely moving.';
                    projHtml = '<div class="g1-chart"><h3><i data-lucide="chart-line" style="width:15px;height:15px;vertical-align:-2px;"></i> Projections</h3>' +
                        '<div class="note2">Linear fit of processing-date advancement. Overall: <strong>' + proj.rateWeek.toFixed(1) +
                        ' days/week</strong> · Recent (last ' + Math.min(10, proj.count) + '): <strong>' + proj.recentWeek.toFixed(1) +
                        ' days/week</strong>. ' + pace + '</div>' +
                        '<div class="table-wrap" style="margin-top:12px;"><table class="results-table"><thead><tr><th>Milestone</th><th>Projected processing date</th></tr></thead><tbody>' +
                        '<tr><td>Today (' + proj.todayStr + ')</td><td><span class="pill blue">' + proj.remaining + ' days to clear</span></td></tr>' +
                        (proj.etaDate
                            ? '<tr><td>Reaches today in ~' + proj.etaDays + ' days</td><td><strong>' + fmtG1Date(proj.etaDate) + '</strong></td></tr>'
                            : '<tr><td>Catch-up ETA</td><td>Stalled at current pace</td></tr>') +
                        proj.ahead.map(function(a) {
                            return '<tr><td class="mono">+' + a.days + ' days</td><td class="mono">' + fmtG1Date(a.proc) + '</td></tr>';
                        }).join('') +
                        '</tbody></table></div></div>';
                }
                var chart = '<div class="g1-chart"><h3>Lag over time</h3>' +
                    '<div class="g1-lag" id="g1-lag" data-ac-label="average lag"></div>' +
                    '<div class="note2">Weekly mean of the observations in <code>data/stamp_1g.json</code>.</div></div>';
                var histRows = rows.slice().reverse().map(function(r) {
                    return '<tr><td class="mono">' + r.run_date + '</td><td class="mono">' + r.processing_date +
                        '</td><td>' + r.lag_days + '</td><td>' + r.lag_weeks.toFixed(2) + '</td></tr>';
                }).join('');
                var hist = '<div class="table-wrap"><table class="results-table"><thead><tr><th>Observed</th><th>ISD processing date</th><th>Lag (days)</th><th>Lag (weeks)</th></tr></thead>' +
                    '<tbody>' + histRows + '</tbody></table></div>';
                var note = '<div class="readme"><h3 class="readme-title">How this tracker works</h3>' +
                    '<p>Every day, an automated job reads the ISD renewal page, finds each stamp category\u2019s processing date, and appends one row per category to ' +
                    '<a href="data/stamp_1g.json" target="_blank" rel="noopener"><code>data/stamp_1g.json</code></a> in this repo. The rate and ETA above are a straight-line fit through that history - not a promise.</p></div>';
                var storedDate = g1StoredDate();
                var storedMode = g1StoredMode();
                var storedExpiry = g1StoredExpiry();
                var estimatorHtml = '<div class="g1-chart"><h3>Your application</h3>' +
                    '<div class="note2">When did you apply - or when do you plan to? Your tentative outcome date updates itself as the lag moves.</div>' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
                    '<span class="g1-mode" style="display:inline-flex;align-items:center;gap:8px;" data-jelly-radio data-jelly-bare data-jelly-size="sm" data-jelly-radius="999" data-jelly-swell="0.08" data-jelly-barge="2" data-jelly-shrink="0.03">' +
                    '<button type="button" class="recent-chip mode-chip' + (storedMode === 'applied' ? ' active' : '') + '" data-mode="applied" aria-pressed="' + (storedMode === 'applied') + '">I applied</button>' +
                    '<button type="button" class="recent-chip mode-chip' + (storedMode === 'plan' ? ' active' : '') + '" data-mode="plan" aria-pressed="' + (storedMode === 'plan') + '">I plan to apply</button>' +
                    '</span>' +
                    '<div class="datefilter"><label class="visually-hidden" for="g1-apply-date">Application date</label>' +
                    '<input type="date" id="g1-apply-date" autocomplete="off" aria-label="Your application date" value="' + escapeHtml(storedDate) + '" data-calendar>' +
                    '<button type="button" class="clear-btn" id="g1-apply-clear" aria-label="Clear application date" title="Clear application date">\u00d7</button>' +
                    '</div></div>' +
                    '<div class="g1-buffer"><span class="note2">Buffer</span>' +
                    '<div id="g1-buffer" class="stp-host"></div>' +
                    '<span class="note2">weeks on top of the current lag</span></div>' +
                    '<div id="g1-estimate" aria-live="polite"></div>' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
                    '<label for="g1-expiry-date" style="font-size:12px;color:var(--ink-muted);">IRP expiry (optional)</label>' +
                    '<div class="datefilter"><label class="visually-hidden" for="g1-expiry-date">IRP expiry date</label>' +
                    '<input type="date" id="g1-expiry-date" autocomplete="off" aria-label="Your IRP expiry date" value="' + escapeHtml(storedExpiry) + '" data-calendar>' +
                    '<button type="button" class="clear-btn" id="g1-expiry-clear" aria-label="Clear expiry date" title="Clear expiry date">\u00d7</button>' +
                    '</div></div>' +
                    '<div id="g1-expiry" aria-live="polite"></div></div>' +
                    '<div id="g1-timeline-form" style="margin-top:24px;"></div>';
                return head + catPills + hero + cards + estimatorHtml + projHtml + chart + hist + '<div id="community-box"></div>' + note;
            }

            async function renderG1Page() {
                document.title = 'Stamp 1G Processing Tracker | Irish Visa Decision Tracker';
                if (!g1Cache) {
                    root.innerHTML = BACK_BTN_HTML +
                        '<div class="eyebrow">Ireland \u00b7 Immigration Service Delivery</div>' +
                        '<div class="titlerow"><h1>Stamp 1G Tracker</h1>' +
                        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' + THEME_BTN_HTML + '</div></div>' +
                        '<div class="cards">' +
                        '<div class="skel skel-card" style="animation-delay:0.02s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.07s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.12s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.17s"></div>' +
                        '</div>';
                    wireChrome();
                }
                await loadG1Data();
                // A visa-tab switch may have rendered while we fetched.
                if (activeTracker !== '1g') return;
                var allRows = g1Cache || [];
                var cat = g1StoredCategory(allRows);
                g1ActiveRows = g1RowsFor(allRows, cat);
                root.innerHTML = renderG1Layout(g1ActiveRows, g1Categories(allRows), cat);
                wireChrome();
                renderG1LagChart(g1ActiveRows);
                var catRow = document.getElementById('g1-cats');
                if (catRow) catRow.addEventListener('click', function(e) {
                    var chip = e.target && e.target.closest ? e.target.closest('[data-cat]') : null;
                    if (!chip) return;
                    try { localStorage.setItem('stamp1g-category', chip.getAttribute('data-cat')); } catch (err) { /* private mode */ }
                    renderG1Page();
                });
                var g1DateEl = document.getElementById('g1-apply-date');
                if (g1DateEl) g1DateEl.addEventListener('change', function() {
                    applyG1DateBounds();
                    g1SaveEstimate();
                    paintG1Estimate();
                });
                var g1ClearEl = document.getElementById('g1-apply-clear');
                if (g1ClearEl) g1ClearEl.addEventListener('click', function() {
                    if (g1DateEl) g1DateEl.value = '';
                    g1SaveEstimate();
                    paintG1Estimate();
                    if (g1DateEl) g1DateEl.focus();
                });
                var modeChips = root.querySelectorAll('.mode-chip');
                for (var mi = 0; mi < modeChips.length; mi++) {
                    modeChips[mi].addEventListener('click', function() {
                        try { localStorage.setItem('stamp1g-apply-mode', this.getAttribute('data-mode')); } catch (e) { /* private mode */ }
                        for (var mj = 0; mj < modeChips.length; mj++) {
                            var on = modeChips[mj] === this;
                            modeChips[mj].classList.toggle('active', on);
                            modeChips[mj].setAttribute('aria-pressed', on ? 'true' : 'false');
                        }
                        applyG1DateBounds();
                        paintG1Estimate();
                    });
                }
                applyG1DateBounds();
                paintG1Buffer();
                paintG1Estimate();
                var g1ExpEl = document.getElementById('g1-expiry-date');
                if (g1ExpEl) g1ExpEl.addEventListener('change', function() {
                    try {
                        if (g1ExpEl.value) localStorage.setItem('stamp1g-expiry', g1ExpEl.value);
                        else localStorage.removeItem('stamp1g-expiry');
                    } catch (err) { /* private mode */ }
                    paintG1Expiry();
                });
                var g1ExpClear = document.getElementById('g1-expiry-clear');
                if (g1ExpClear) g1ExpClear.addEventListener('click', function() {
                    if (g1ExpEl) g1ExpEl.value = '';
                    try { localStorage.removeItem('stamp1g-expiry'); } catch (err) { /* private mode */ }
                    paintG1Expiry();
                    if (g1ExpEl) g1ExpEl.focus();
                });
                paintG1Expiry();
                paintCommunityBox('1g');
                // 1G timeline form (separate from the embassy-visa one).
                var g1TimelineForm = document.getElementById('g1-timeline-form');
                if (g1TimelineForm) {
                    g1TimelineForm.innerHTML = renderG1TimelineForm();
                    var timeForm1g = document.getElementById('time-form-1g');
                    if (timeForm1g) timeForm1g.addEventListener('submit', function(e) {
                        e.preventDefault();
                        submitTimeline(true);
                    });
                }
                showHero();
            }

            // ====== PERMITS TRACKER (item 7) ======
            // Same visual language as the 1G page (hero, cards, history) over
            // data/work_permits.json, with per-category pills. Lighter than
            // 1G: no estimator or projections panel (yet).
            function permitsStoredCategory(rows) {
                var cats = g1Categories(rows);
                if (!cats.length) return '';
                try {
                    var saved = localStorage.getItem('permits-category') || '';
                    if (saved && cats.indexOf(saved) !== -1) return saved;
                } catch (e) { /* private mode */ }
                return cats[0];
            }

            function renderPermitsLayout(rows, cats, activeCat) {
                cats = cats && cats.length ? cats : [];
                var head = BACK_BTN_HTML +
                    '<div class="eyebrow">Ireland \u00b7 Dept. of Enterprise (DETE)</div>' +
                    '<div class="titlerow"><h1>Employment Permit Tracker</h1>' +
                    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' + THEME_BTN_HTML + '</div></div>' +
                    '<div class="sub">' + (rows.length ? rows.length + ' observation' + (rows.length === 1 ? '' : 's') + ' on record' : 'Awaiting data') + '</div>';
                if (!rows.length) {
                    return head +
                        '<div class="empty">No observations recorded yet. The daily job writes to <code>data/work_permits.json</code> - check back after its first run.</div>';
                }
                var catPills = cats.length > 1
                    ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;" id="permits-cats" role="group" aria-label="Permit category">' +
                      cats.map(function(c) {
                          return '<button type="button" class="recent-chip mode-chip' + (c === activeCat ? ' active' : '') +
                              '" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (c === activeCat) + '">' + escapeHtml(c) + '</button>';
                      }).join('') + '</div>'
                    : '';
                var proj = computeG1Projections(rows);
                var latest = rows[rows.length - 1];
                var hero = '<div class="hero" id="hero" data-id="permits" style="opacity:0">' +
                    '<div class="hero-body"><div>' +
                    '<h2 class="hero-title">Processing ' + fmtG1Date(latest.processing_date) + '.</h2>' +
                    '<div class="hero-sub">' + latest.lag_days + ' days (~' + fmtLagMonths(latest.lag_days) + ' mo) behind today' +
                    (proj.ok && proj.recentWeek !== null ? ', advancing ~' + proj.recentWeek.toFixed(1) + ' days/week.' : '.') + '</div>' +
                    '</div><div class="visual">' +
                    '<div class="ring"></div><div class="ring"></div><div class="ring"></div>' +
                    '<div class="ring-core">' + latest.lag_days + '</div>' +
                    '</div></div></div>';
                var cards = '<div class="cards">' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>Permit date</div><div class="value">' + fmtG1Date(latest.processing_date) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="hourglass"></i>Current lag</div><div class="value">' + latest.lag_days + ' days <span style="font-size:13px;font-weight:600;">(~' + fmtLagMonths(latest.lag_days) + ' mo)</span></div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="trending-up"></i>Advancement rate</div><div class="value">' +
                    (proj.ok ? proj.recentWeek.toFixed(1) + ' <span style="font-size:13px;font-weight:600;">days/week</span>' : '-') + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="flag"></i>ETA to today</div><div class="value">' +
                    (proj.ok && proj.etaDate ? fmtG1Date(proj.etaDate) + ' <span style="font-size:13px;font-weight:600;">(in ~' + proj.etaDays + 'd)</span>' : (proj.ok ? 'Stalled' : '-')) + '</div></div>' +
                    '</div>';
                var histRows = rows.slice().reverse().map(function(r) {
                    return '<tr><td class="mono">' + r.run_date + '</td><td>' + escapeHtml(r.category || '') +
                        '</td><td class="mono">' + r.processing_date + '</td><td>' + r.lag_days + '</td></tr>';
                }).join('');
                var hist = '<div class="table-wrap"><table class="results-table"><thead><tr><th>Observed</th><th>Category</th><th>Permit date</th><th>Lag (days)</th></tr></thead>' +
                    '<tbody>' + histRows + '</tbody></table></div>';
                var note = '<div class="readme"><h3 class="readme-title">How this tracker works</h3>' +
                    '<p>Every day, an automated job reads DETE\u2019s current processing dates and appends one row per permit category to ' +
                    '<a href="data/work_permits.json" target="_blank" rel="noopener"><code>data/work_permits.json</code></a> in this repo.</p></div>';
                return head + catPills + hero + cards + hist + note;
            }

            async function renderPermitsPage() {
                document.title = 'Employment Permit Tracker | Irish Visa Decision Tracker';
                if (!permitsCache) {
                    root.innerHTML = BACK_BTN_HTML +
                        '<div class="eyebrow">Ireland \u00b7 Dept. of Enterprise (DETE)</div>' +
                        '<div class="titlerow"><h1>Employment Permit Tracker</h1>' +
                        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' + THEME_BTN_HTML + '</div></div>' +
                        '<div class="cards">' +
                        '<div class="skel skel-card" style="animation-delay:0.02s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.07s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.12s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.17s"></div>' +
                        '</div>';
                    wireChrome();
                }
                await loadPermitsData();
                if (activeTracker !== 'permits') return;
                var allRows = permitsCache || [];
                var cat = permitsStoredCategory(allRows);
                root.innerHTML = renderPermitsLayout(g1RowsFor(allRows, cat), g1Categories(allRows), cat);
                wireChrome();
                var catRow = document.getElementById('permits-cats');
                if (catRow) catRow.addEventListener('click', function(e) {
                    var chip = e.target && e.target.closest ? e.target.closest('[data-cat]') : null;
                    if (!chip) return;
                    try { localStorage.setItem('permits-category', chip.getAttribute('data-cat')); } catch (err) { /* private mode */ }
                    renderPermitsPage();
                });
                showHero();
            }

            function trackerCardHTML(id, icon, title, desc, meta, metaId, accent) {
                return '<button type="button" class="tracker-card' + (accent ? ' ' + accent : '') + '" data-tracker="' + id + '">' +
                    '<span class="tracker-chip"><i data-lucide="' + icon + '"></i></span>' +
                    '<h2>' + title + '</h2><p>' + desc + '</p>' +
                    '<span class="tracker-meta" id="' + metaId + '" aria-live="polite">' + meta + '</span>' +
                    '<span class="tracker-cta">Open tracker \u2192</span></button>';
            }

            // Landing status strip: one glanceable line built from the tiny
            // meta file + 1G history (never the full visa payload). Pure
            // function of its inputs so it can be unit-tested; numbers only,
            // no user-controlled strings - no escaping needed.
            function landingStatusHTML(meta, g1Rows, todayIST) {
                var parts = [];
                // Ticker tracks the headline 1G series even once other stamp
                // categories share the file.
                g1Rows = g1RowsFor(g1Rows, '1G');
                var wd = new Date(todayIST + 'T00:00:00').getDay();
                if (wd === 0 || wd === 6) {
                    parts.push('Embassy closed today - back Monday');
                } else if (meta && meta.lastRunAt) {
                    if (String(meta.lastRunAt).slice(0, 10) === todayIST) {
                        parts.push('Today\u2019s embassy file is in' +
                            (meta.newRows ? ' \u00b7 <strong>' + meta.newRows + ' new decisions</strong>' : ''));
                    } else {
                        parts.push('Today\u2019s embassy file not yet published (expected ~11:00 AM IST)');
                    }
                } else {
                    parts.push('Visa decisions updated daily');
                }
                if (g1Rows && g1Rows.length) {
                    var lagNow = g1Rows[g1Rows.length - 1].lag_days;
                    // Weekly movement: compare against the closest observation
                    // at least 7 days older (archive gaps make "exactly 7" rare).
                    var move = '';
                    var cutoff = g1ToDay(g1Rows[g1Rows.length - 1].run_date) - 7;
                    for (var i = g1Rows.length - 2; i >= 0; i--) {
                        if (g1ToDay(g1Rows[i].run_date) <= cutoff) {
                            var d = lagNow - g1Rows[i].lag_days;
                            if (d !== 0) move = ' (' + (d > 0 ? '\u2191' : '\u2193') + Math.abs(d) + ' this week)';
                            break;
                        }
                    }
                    parts.push('Stamp 1G lag <strong>' + lagNow + ' days</strong>' + move);
                }
                return parts.join(' <span aria-hidden="true">\u00b7</span> ');
            }

            // ===== Landing-page sections =====
            // Everything below is only used by renderLandingPage(). Each
            // section paints independently: a failed fetch can never stop the
            // landing page (or the tracker behind it) from rendering.
            var _landingDataRequested = false;
            var _embassyManifest = null;
            var _pwaPromptBound = false;

            function initLandingComponents() {
                try { updateLandingStats(); } catch (e) { console.warn('stats:', e); }
                try { renderEmbassyStatusGrid(); } catch (e) { console.warn('embassies:', e); }
                try { renderCommunityWaitTimes(); } catch (e) { console.warn('community:', e); }
                try { renderProcessingEstimator(); } catch (e) { console.warn('estimator:', e); }
                try { renderRecentDecisionsFeed(); } catch (e) { console.warn('recent:', e); }
                try { setupPWAInstallButton(); } catch (e) { console.warn('pwa:', e); }
                try { initCalendarComponents(); } catch (e) { console.warn('calendar:', e); }

                // The stats/estimator/recent sections need the visa history.
                // Fetch it in the background after first paint so the landing
                // page stays instant, then repaint just those sections.
                if (!_landingDataRequested && (!cache || !cache.length)) {
                    _landingDataRequested = true;
                    loadData().then(function() {
                        if (activeTracker !== 'home') return;
                        try { updateLandingStats(); } catch (e) { /* noop */ }
                        try { renderProcessingEstimator(); } catch (e) { /* noop */ }
                        try { renderRecentDecisionsFeed(); } catch (e) { /* noop */ }
                        try { renderEmbassyCoverageTable(); } catch (e) { /* noop */ }
                    }).catch(function() { /* offline: empty states are fine */ });
                }
            }

            function initCalendarComponents() {
                if (!window.ShadcnCalendar) return;
                document.querySelectorAll('input[type="date"][data-calendar]').forEach(function(input) {
                    if (input._calendarInitialized) return;
                    input._calendarInitialized = true;
                    new window.ShadcnCalendar(input, {
                        onSelect: function(date) {
                            input.value = date.toISOString().split('T')[0];
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                        },
                        initialDate: input.value ? new Date(input.value) : new Date(),
                        minDate: input.min,
                        maxDate: input.max
                    });
                });
            }

            function updateLandingStats() {
                var real = realRows(cache || []);
                var approved = real.filter(function(r) { return r._status === 'accepted'; }).length;
                var rate = real.length ? (approved / real.length * 100).toFixed(1) + '%' : '\u2014';

                var decisionsEl = document.getElementById('stat-decisions');
                var approvalEl = document.getElementById('stat-approval');
                var updatedEl = document.getElementById('stat-updated');

                if (decisionsEl) {
                    decisionsEl.textContent = real.length ? real.length.toLocaleString() : '\u2014';
                }
                if (approvalEl) approvalEl.textContent = rate;
                if (updatedEl) updatedEl.textContent = '\u2014';

                // Count + freshness come from the tiny meta file, so this fills
                // in even while the full history is still downloading.
                Promise.all([
                    loadVisaCount().catch(function() { return null; }),
                    fetch(VISA_META_URL, { cache: 'no-store' })
                        .then(function(r) { return r.ok ? r.json() : null; })
                        .catch(function() { return null; })
                ]).then(function(res) {
                    var n = res[0], meta = res[1];
                    if (decisionsEl && n) decisionsEl.textContent = n.toLocaleString();
                    if (updatedEl && meta && meta.lastRunAt) {
                        updatedEl.textContent = String(meta.lastRunAt).slice(0, 10);
                    }
                });

                var visaEl = document.getElementById('visa-meta');
                if (visaEl && cache && cache.length) {
                    visaEl.textContent = real.length.toLocaleString() + ' decisions on record';
                }
            }

            // Embassy status cards. Each embassy data file is
            // { decisions: [...] } - there is no separate meta file for them,
            // so derive "latest decision" and the record count from the rows.
            function renderEmbassyStatusGrid() {
                var container = document.getElementById('embassy-status-grid');
                if (!container) return;

                var embassies = [
                    { slug: 'new-delhi', name: 'New Delhi', flag: '\uD83C\uDDEE\uD83C\uDDF3' },
                    { slug: 'beijing', name: 'Beijing', flag: '\uD83C\uDDE8\uD83C\uDDF3' },
                    { slug: 'dublin', name: 'Dublin', flag: '\uD83C\uDDEE\uD83C\uDDEA' },
                    { slug: 'abu-dhabi', name: 'Abu Dhabi', flag: '\uD83C\uDDE6\uD83C\uDDEA' },
                    { slug: 'abuja', name: 'Abuja', flag: '\uD83C\uDDF3\uD83C\uDDEC' },
                    { slug: 'ankara', name: 'Ankara', flag: '\uD83C\uDDF9\uD83C\uDDF7' }
                ];

                var html = '<h3 class="landing-h3">Embassy status</h3><div class="embassy-status-cards">';
                embassies.forEach(function(emb) {
                    html += '<div class="embassy-status-card" data-embassy="' + emb.slug + '">' +
                        '<div class="embassy-header">' +
                        '<span class="embassy-flag" aria-hidden="true">' + emb.flag + '</span>' +
                        '<span class="embassy-name">' + emb.name + '</span>' +
                        '</div>' +
                        '<div class="embassy-meta" id="embassy-meta-' + emb.slug + '">Loading\u2026</div>' +
                        '</div>';
                });
                container.innerHTML = html + '</div>' +
                    '<div class="embassy-coverage">' +
                    '<div class="table-wrap coverage-table-wrap" role="region" aria-label="Per-office coverage" tabindex="0">' +
                    '<table class="coverage-table">' +
                    '<caption>Latest published total and report date for each office.</caption>' +
                    '<thead><tr><th scope="col">Office</th><th scope="col" class="num">Decisions</th><th scope="col">Report date</th><th scope="col">History range</th></tr></thead>' +
                    '<tbody id="embassy-coverage-body"><tr><td colspan="4" class="coverage-empty">Loading coverage\u2026</td></tr></tbody>' +
                    '</table></div></div>';

                function paint(office) {
                    var el = document.getElementById('embassy-meta-' + office.slug);
                    if (!el) return;
                    if (office.status && office.status !== 'official') {
                        el.innerHTML = '<span class="embassy-status stale">' + escapeHtml(String(office.status).replace(/_/g, ' ')) + '</span>' +
                            '<span class="embassy-count">' + escapeHtml(office.note || 'Not currently ingested') + '</span>';
                        return;
                    }
                    el.innerHTML = '<span class="embassy-status live">As of ' + escapeHtml(office.report_date || office.as_of || '\u2014') + '</span>' +
                        '<span class="embassy-count">' + Number(office.decisions || 0).toLocaleString() + ' decisions</span>' +
                        (office.corrections ? '<span class="embassy-count">' + office.corrections + ' correction(s)</span>' : '');
                }

                fetch('data/data_manifest.json', { cache: 'no-store' })
                    .then(function(r) { return r.ok ? r.json() : null; })
                    .then(function(manifest) {
                        var offices = (manifest && manifest.offices) || [];
                        if (!offices.length) throw new Error('no manifest');
                        var bySlug = {};
                        offices.forEach(function(o) { bySlug[o.slug] = o; });
                        embassies.forEach(function(emb) { if (bySlug[emb.slug]) paint(bySlug[emb.slug]); });
                        _embassyManifest = offices;
                        renderEmbassyCoverageTable();
                    })
                    .catch(function() {
                        _embassyManifest = null;
                        var coverageBody = document.getElementById('embassy-coverage-body');
                        if (coverageBody) coverageBody.innerHTML = '<tr><td colspan="4" class="coverage-empty">Coverage data is unavailable right now.</td></tr>';
                        embassies.forEach(function(emb) {
                            fetch('data/embassy-' + emb.slug + '.json', { cache: 'no-store' })
                                .then(function(r) { return r.ok ? r.json() : null; })
                                .then(function(data) {
                                    var el = document.getElementById('embassy-meta-' + emb.slug);
                                    if (!el) return;
                                    var rows = (data && data.decisions) || [];
                                    el.innerHTML = rows.length
                                        ? '<span class="embassy-status live">' + rows.length.toLocaleString() + ' decisions</span>'
                                        : '<span class="embassy-status stale">No data</span>';
                                });
                        });
                    });
            }

            // Latest manifest counts and report dates, with New Delhi history
            // derived from the decision cache already used by the landing page.
            function renderEmbassyCoverageTable() {
                var body = document.getElementById('embassy-coverage-body');
                if (!body || !_embassyManifest) return;

                var order = ['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara'];
                var bySlug = {};
                _embassyManifest.forEach(function(office) { bySlug[office.slug] = office; });

                var ndRange = null;
                if (Array.isArray(cache) && cache.length) {
                    var min = '', max = '';
                    cache.forEach(function(row) {
                        var date = row && row.date;
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
                        if (!/^(Approved|Refused)$/i.test(String(row.decision || ''))) return;
                        if (!min || date < min) min = date;
                        if (!max || date > max) max = date;
                    });
                    if (min && max) ndRange = { start: min, end: max };
                }

                var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                function monthName(value) { return months[Number(value) - 1] || ''; }
                function formatDate(value) {
                    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
                    if (!match) return '\u2014';
                    return Number(match[3]) + ' ' + monthName(match[2]) + ' ' + match[1];
                }
                function formatRange(range) {
                    if (!range) return 'Loading decision history\u2026';
                    if (range.start === range.end) return formatDate(range.start);
                    var start = range.start.split('-'), end = range.end.split('-');
                    if (start[0] === end[0]) {
                        return Number(start[2]) + ' ' + monthName(start[1]) + ' \u2013 ' + Number(end[2]) + ' ' + monthName(end[1]) + ' ' + end[0];
                    }
                    return formatDate(range.start) + ' \u2013 ' + formatDate(range.end);
                }

                body.innerHTML = order.map(function(slug) {
                    var office = bySlug[slug];
                    if (!office) {
                        return '<tr><td><strong>' + escapeHtml(slug.replace(/-/g, ' ')) + '</strong></td><td class="num">\u2014</td><td>\u2014</td><td class="coverage-empty">Not published</td></tr>';
                    }
                    var history = slug === 'new-delhi'
                        ? formatRange(ndRange)
                        : formatDate(office.report_date) + ' <span class="coverage-snapshot">snapshot</span>';
                    return '<tr>' +
                        '<td><strong>' + escapeHtml(office.name || slug) + '</strong></td>' +
                        '<td class="num">' + Number(office.decisions || 0).toLocaleString() + '</td>' +
                        '<td>' + formatDate(office.report_date) + '</td>' +
                        '<td>' + history + '</td>' +
                        '</tr>';
                }).join('');
            }

            // Community-reported wait times for embassy visas. The JSON is an
            // array of { tracker, applied, decided, visa_type? } rows.
            function renderCommunityWaitTimes() {
                var container = document.getElementById('community-wait-section');
                if (!container) return;

                fetch('data/community_timelines.json', { cache: 'no-store' })
                    .then(function(r) { return r.ok ? r.json() : null; })
                    .then(function(data) {
                        var rows = Array.isArray(data) ? data : ((data && data.timelines) || []);
                        rows = rows.filter(function(r) {
                            return (!r.tracker || r.tracker === 'visa') && r.applied && r.decided;
                        });

                        if (!rows.length) {
                            container.innerHTML = '<h3 class="landing-h3">Community wait times</h3>' +
                                '<p class="note2">No community timelines shared yet. ' +
                                '<a href="/?tracker=visa&tab=suggest">Share yours</a> to help others plan.</p>';
                            return;
                        }

                        var byType = {};
                        rows.forEach(function(r) {
                            var type = r.visa_type || 'All visa types';
                            if (!byType[type]) byType[type] = [];
                            var diff = (new Date(r.decided) - new Date(r.applied)) / 86400000;
                            if (diff > 0 && diff < 500) byType[type].push(diff);
                        });

                        var html = '<h3 class="landing-h3">Community wait times <span class="note2">(self-reported)</span></h3>' +
                            '<div class="wait-times-table"><table class="results-table"><thead><tr>' +
                            '<th scope="col">Visa type</th><th scope="col">Median</th>' +
                            '<th scope="col">25th percentile</th><th scope="col">75th percentile</th>' +
                            '<th scope="col">Reports</th></tr></thead><tbody>';
                        var any = false;
                        Object.keys(byType).sort().forEach(function(type) {
                            var days = byType[type].sort(function(a, b) { return a - b; });
                            if (days.length < 3) return;
                            any = true;
                            var median = days[Math.floor(days.length / 2)];
                            var p25 = days[Math.floor(days.length * 0.25)];
                            var p75 = days[Math.floor(days.length * 0.75)];
                            html += '<tr><td>' + escapeHtml(type) + '</td>' +
                                '<td><strong>' + median + ' days</strong></td>' +
                                '<td>' + p25 + ' days</td>' +
                                '<td>' + p75 + ' days</td>' +
                                '<td>' + days.length + '</td></tr>';
                        });
                        if (!any) {
                            html += '<tr><td colspan="5" class="note2">Not enough reports yet ' +
                                '(at least 3 per visa type are needed).</td></tr>';
                        }
                        container.innerHTML = html + '</tbody></table></div>';
                    })
                    .catch(function() {
                        container.innerHTML = '<h3 class="landing-h3">Community wait times</h3>' +
                            '<p class="note2">Unable to load community data.</p>';
                    });
            }

            // Processing-time estimator, backed by /api/predict (the trained
            // XGBoost tree ensemble shipped in functions/api/model-trees.js).
            function renderProcessingEstimator() {
                var container = document.getElementById('estimator-section');
                if (!container) return;
                // Don't rebuild the form while the user has it open with values.
                if (container.dataset.ready === '1') return;
                container.dataset.ready = '1';

                container.innerHTML =
                    '<h3 class="landing-h3">Processing time estimator</h3>' +
                    '<form class="estimator-form" id="estimator-form" novalidate>' +
                    '<div class="est-field"><label for="estimator-visa-type">Visa type</label>' +
                    '<select id="estimator-visa-type" name="visa_type">' +
                    '<option value="">Select\u2026</option>' +
                    '<option value="study">Study</option><option value="work">Work</option>' +
                    '<option value="visit">Visit</option><option value="family">Family</option>' +
                    '<option value="transit">Transit</option><option value="research">Research</option>' +
                    '</select></div>' +
                    '<div class="est-field"><label for="estimator-app-date">Application date</label>' +
                    '<input type="date" id="estimator-app-date" name="application_date" data-calendar></div>' +
                    '<div class="est-field"><label for="estimator-embassy">Visa office</label>' +
                    '<select id="estimator-embassy" name="embassy">' +
                    '<option value="new-delhi">New Delhi</option><option value="beijing">Beijing</option>' +
                    '<option value="dublin">Dublin</option><option value="abu-dhabi">Abu Dhabi</option>' +
                    '<option value="abuja">Abuja</option><option value="ankara">Ankara</option>' +
                    '</select></div>' +
                    '<div class="est-field"><label for="estimator-app-num">Application number <span class="note2">(optional)</span></label>' +
                    '<input type="text" id="estimator-app-num" name="application_number" inputmode="numeric" ' +
                    'autocomplete="off" maxlength="20" placeholder="e.g. IRL2026123456"></div>' +
                    '<div class="est-submit"><button class="btn" type="submit" id="estimator-calc-btn">Calculate</button></div>' +
                    '</form>' +
                    '<div id="estimator-result" class="estimator-result" hidden></div>' +
                    '<p class="note2 est-note">Illustrative estimate from a model trained on synthetic historical data. Not a prediction of your case and not an official processing time.</p>';

                var form = document.getElementById('estimator-form');
                if (form) form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    calculateEstimate();
                });
            }

            function estimatorError(resultDiv, message) {
                resultDiv.hidden = false;
                resultDiv.innerHTML = '<p class="note2">' + escapeHtml(message) + '</p>';
            }

            async function calculateEstimate() {
                var visaTypeEl = document.getElementById('estimator-visa-type');
                var appDateEl = document.getElementById('estimator-app-date');
                var embassyEl = document.getElementById('estimator-embassy');
                var appNumEl = document.getElementById('estimator-app-num');
                var resultDiv = document.getElementById('estimator-result');
                if (!visaTypeEl || !appDateEl || !embassyEl || !resultDiv) return;

                var visaType = visaTypeEl.value;
                var appDate = appDateEl.value;
                if (!visaType || !appDate) {
                    estimatorError(resultDiv, 'Choose a visa type and application date first.');
                    return;
                }

                resultDiv.hidden = false;
                resultDiv.innerHTML = '<p class="note2">Calculating\u2026</p>';

                var payload = {
                    application_number: (appNumEl && appNumEl.value.trim()) || 'IRL00000000',
                    application_date: appDate,
                    visa_type: visaType,
                    embassy: embassyEl.value || 'new-delhi'
                };

                try {
                    var res = await fetch('/api/predict', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    var data = await res.json();
                    if (!res.ok) throw new Error(data && data.error ? data.error : 'Prediction failed');
                    var p = data.prediction;
                    resultDiv.innerHTML =
                        '<h4 class="est-result-title">Estimated decision: <strong>' +
                        escapeHtml(p.estimated_decision_date) + '</strong></h4>' +
                        '<div class="est-result-grid">' +
                        '<div class="stat"><span class="stat-value">' + p.predicted_days + '</span>' +
                        '<span class="stat-label">Days from application</span></div>' +
                        '<div class="stat"><span class="stat-value">' + p.confidence_interval.lower +
                        '\u2013' + p.confidence_interval.upper + '</span>' +
                        '<span class="stat-label">95% range (days)</span></div>' +
                        '</div>';
                } catch (e) {
                    estimatorError(resultDiv, 'Estimate unavailable right now: ' + e.message);
                }
            }

            function renderRecentDecisionsFeed() {
                var container = document.getElementById('recent-decisions-section');
                if (!container) return;

                var real = realRows(cache || []);
                if (!real.length) {
                    container.innerHTML = '<h3 class="landing-h3">Latest decisions</h3>' +
                        '<p class="note2">' + (cache === null || cache === undefined
                            ? 'Loading the latest published decisions\u2026'
                            : 'No decisions published yet.') + '</p>';
                    return;
                }

                var recent = real.slice(0, 10);
                var html = '<h3 class="landing-h3">Latest decisions <span class="note2">(most recent file)</span></h3>' +
                    '<div class="table-wrap"><table class="results-table"><thead><tr>' +
                    '<th scope="col">Decision date</th><th scope="col">Application no.</th>' +
                    '<th scope="col">Decision</th><th scope="col">Office</th>' +
                    '</tr></thead><tbody>';
                recent.forEach(function(r) {
                    html += '<tr>' +
                        '<td class="mono">' + escapeHtml(r.date) + '</td>' +
                        '<td class="mono">' + escapeHtml(r.irl) + '</td>' +
                        '<td><span class="pill ' + (r._pillClass || 'amber') + '">' +
                        escapeHtml(r.decision || '-') + '</span></td>' +
                        '<td>' + escapeHtml(r.embassy || 'new-delhi') + '</td>' +
                        '</tr>';
                });
                container.innerHTML = html + '</tbody></table></div>';
                ensureScrollableFocusable();
            }

            function setupPWAInstallButton() {
                var btn = document.getElementById('pwa-install-btn');
                if (!btn) return;
                var deferredPrompt = null;

                if (!_pwaPromptBound) {
                    _pwaPromptBound = true;
                    window.addEventListener('beforeinstallprompt', function(e) {
                        e.preventDefault();
                        window._visaInstallPrompt = e;
                        var liveBtn = document.getElementById('pwa-install-btn');
                        if (liveBtn) liveBtn.hidden = false;
                    });
                }

                btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    deferredPrompt = window._visaInstallPrompt;
                    if (deferredPrompt) {
                        deferredPrompt.prompt();
                        deferredPrompt.userChoice.then(function(result) {
                            if (result.outcome === 'accepted') console.log('PWA installed');
                            window._visaInstallPrompt = null;
                            deferredPrompt = null;
                            btn.hidden = true;
                        });
                    } else {
                        alert('This app is already installed, or your browser does not support installation.');
                    }
                });
            }

async function renderLandingPage() {
                document.title = 'Irish Visa Decision Tracker - New Delhi Visa Decisions & Stamp 1G';
                // Paint the cards IMMEDIATELY with placeholder stats - never
                // block on the network. Each card's meta line fills in as its
                // own fetch resolves (both are small static files, so this is
                // fast; the full visa history still loads on tracker entry).
                // Clicking a card works from the first paint.
                root.innerHTML =
                    '<div class="landing-wrap">' +
                    '<div class="eyebrow">Ireland \u00b7 Live trackers</div>' +
                    '<div class="titlerow"><h1>Choose your tracker</h1>' +
                    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' + THEME_BTN_HTML + '</div></div>' +
                    '<div class="sub">Three daily trackers, one dashboard.</div>' +
                    '<div class="landing-status" id="landing-status" aria-live="polite"><span class="note2">Checking today\u2019s updates\u2026</span></div>' +
                    '<form class="landing-search" id="landing-search" role="search">' +
                    '<div class="searchbar">' + searchIcon() +
                    '<input type="text" id="landing-q" name="q" autocomplete="off" maxlength="200" aria-label="Search by application number" placeholder="Enter your application number\u2026"></div>' +
                    '<button class="btn" type="submit">Track</button></form>' +
                    '<div class="tracker-grid">' +
                    trackerCardHTML('visa', 'plane', 'Embassy Visa Decisions',
                        'Official decisions from six Irish visa offices - searchable by application number, with report dates, trends and summaries.', 'Loading\u2026', 'visa-meta', '') +
                    trackerCardHTML('1g', 'stamp', 'Stamp 1G Processing',
                        'ISD renewal queue: which application date is being processed now, how far behind it is, and when it may catch up.', 'Loading\u2026', 'g1-meta', 'g1') +
                    trackerCardHTML('permits', 'briefcase', 'Employment Permits',
                        'DETE queue: which application dates each permit type has reached, with lags and trends.', 'Loading\u2026', 'permits-meta', 'permits') +
                    '</div>' +
                    // Activation CTA visible before the visitor opens a tracker.
                    '<div class="landing-alert-cta" role="region" aria-label="Decision alerts">' +
                    '<div><p class="activation-kicker">Never miss a decision</p>' +
                    '<strong>Get your decision by email or Telegram</strong>' +
                    '<span>Free, one message when your application appears. Email uses double opt-in.</span></div>' +
                    '<div class="landing-alert-actions">' +
                    '<a class="btn" href="/?tracker=visa&amp;tab=suggest">Email alerts</a>' +
                    '<a class="btn activation-telegram" href="/?tracker=visa&amp;tab=suggest">Telegram alerts</a>' +
                    '</div></div>' +
                    // New: Stats Bar
                    '<div class="stats-bar" role="region" id="landing-stats-bar" aria-label="Live statistics">' +
                    '<div class="stat"><span class="stat-value" id="stat-decisions">--</span><span class="stat-label">Decisions Tracked</span></div>' +
                    '<div class="stat"><span class="stat-value" id="stat-approval">--</span><span class="stat-label">Approval share</span></div>' +
                    '<div class="stat"><span class="stat-value" id="stat-embassies">6</span><span class="stat-label">Visa offices</span></div>' +
                    '<div class="stat"><span class="stat-value" id="stat-updated">--</span><span class="stat-label">Last Updated</span></div>' +
                    '</div>' +
                    // New: Embassy Status Cards
                    '<div class="embassy-status-grid" role="region" id="embassy-status-grid" aria-label="Embassy Status"></div>' +
                    '<p class="note2" id="embassy-coverage-note">Latest report dates vary by office. New Delhi, Abu Dhabi, Abuja and Ankara include dated decision history; Beijing and Dublin show their latest published snapshot. <a href="/visa-processing-times">See Dublin queue dates by category and the submit-by planner</a>.</p>' +
                    // New: Community Wait Times
                    '<div class="community-wait-section" role="region" id="community-wait-section" aria-label="Community Wait Times"></div>' +
                    // New: Processing Estimator
                    '<div class="estimator-section" role="region" id="estimator-section" aria-label="Processing Time Estimator"></div>' +
                    // New: Recent Decisions Feed
                    '<div class="recent-decisions-section" role="region" id="recent-decisions-section" aria-label="Latest Decisions"></div>' +
                    // New: Quick Actions
                    '<div class="quick-actions" role="region" aria-label="Quick Actions">' +
                    '<a class="quick-action" href="/?tab=suggest" data-tracker="suggest"><i data-lucide="bell"></i><span>Get Alerts</span></a>' +
                    '<a class="quick-action" href="/?tab=analytics" data-tracker="analytics"><i data-lucide="bar-chart-2"></i><span>View Analytics</span></a>' +
                    '<a class="quick-action" href="/?tracker=1g" data-tracker="1g"><i data-lucide="calendar"></i><span>Check IRP Expiry</span></a>' +
                    '<a class="quick-action" href="#" id="pwa-install-btn"><i data-lucide="download"></i><span>Install as App</span></a>' +
                    '</div>' +
                    '<div class="landing-foot">Source: official Irish visa office reports. Updated when sources publish.</div></div>';
                wireChrome();
                var cards = root.querySelectorAll('.tracker-card');
                for (var i = 0; i < cards.length; i++) {
                    cards[i].addEventListener('click', function() {
                        setTracker(this.getAttribute('data-tracker'));
                    });
                }
                var lform = document.getElementById('landing-search');
                if (lform) lform.addEventListener('submit', function(e) {
                    e.preventDefault();
                    var q = document.getElementById('landing-q');
                    homeSearchTerm = q ? q.value.trim() : '';
                    setTracker('visa');
                });
                // Count only - the full visa fetch happens on tracker entry
                // (with its own skeleton + snapshot fallback), so landing
                // stays instant no matter how large the history grows.
                Promise.all([
                    loadVisaCount(),
                    loadG1Data(),
                    loadPermitsData(),
                    fetch(VISA_META_URL).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; })
                ]).then(function(res) {
                    if (activeTracker !== 'home') return;
                    var n = res[0], grows = res[1] || [], prows = res[2] || [], meta = res[3];
                    var el = document.getElementById('visa-meta');
                    if (el) el.textContent = n
                        ? n.toLocaleString() + ' decisions on record'
                        : 'Awaiting data';
                    var g1 = document.getElementById('g1-meta');
                    if (g1) g1.textContent = grows.length
                        ? 'Processing ' + fmtG1Date(grows[grows.length - 1].processing_date) +
                          ' \u00b7 ' + grows[grows.length - 1].lag_days + 'd lag (~' + fmtLagMonths(grows[grows.length - 1].lag_days) + ' mo) \u00b7 ' + grows.length + ' observations'
                        : 'Awaiting first observation';
                    var pm = document.getElementById('permits-meta');
                    if (pm) {
                        // Slowest queue among the latest observation day.
                        var plast = null;
                        for (var pi = prows.length - 1; pi >= 0; pi--) {
                            if (pi < prows.length - 1 && prows[pi].run_date !== prows[prows.length - 1].run_date) break;
                            if (!plast || prows[pi].lag_days > plast.lag_days) plast = prows[pi];
                        }
                        pm.textContent = plast
                            ? 'Slowest queue: ' + plast.category + ' at ' + fmtG1Date(plast.processing_date) +
                              ' (' + plast.lag_days + 'd lag)'
                            : 'Awaiting first observation';
                    }
                    var strip = document.getElementById('landing-status');
                    if (strip) {
                        try {
                            strip.innerHTML = landingStatusHTML(meta, grows, istNow().toISOString().slice(0, 10));
                        } catch (e) {
                            strip.innerHTML = '<span class="note2">Trackers updated daily ~11:15 IST.</span>';
                        }
                    }
                });
                // Initialize new landing page components
                initLandingComponents();
                ensureScrollableFocusable();
            }

            // Initial mount: build the chrome (eyebrow, title, navpills, hero) and
            // delegate all tab-content rendering to switchTab() so the layout/rows
            // split is the single source of truth.
            async function render() {
                // Landing + trackers own their skeleton/load/paint cycle and
                // return early - everything below is the visa tracker.
                if (activeTracker === 'home') { await renderLandingPage(); return; }
                if (activeTracker === '1g') { await renderG1Page(); return; }
                if (activeTracker === 'permits') { await renderPermitsPage(); return; }
                document.title = 'Embassy Visa Decisions | Irish Visa Decision Tracker';
                if (!cache) {
                    root.innerHTML = '<div class="eyebrow">Ireland \u00b7 New Delhi Visa Section</div>' +
                        '<div class="titlerow"><h1>Irish Visa Decision Tracker</h1>' +
                        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                        THEME_BTN_HTML +
                        accountBtnHTML() +
                        (typeof createLanguageSelector === 'function' ? createLanguageSelector() : '') +
                        '<div class="stutter-badge"><i>\u24D8</i> Switching tabs may briefly stutter while data loads.</div></div></div>' +
                        '<div class="topbar"><div class="topbar-fill"></div></div>' +
                        '<div class="navpills">' +
                        '<div class="skel skel-pill"></div><div class="skel skel-pill"></div><div class="skel skel-pill"></div><div class="skel skel-pill"></div>' +
                        '</div>' +
                        '<div class="cards">' +
                        '<div class="skel skel-card" style="grid-column:span 2;animation-delay:0.02s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.07s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.12s"></div>' +
                        '<div class="skel skel-card" style="animation-delay:0.17s"></div>' +
                        '</div>' +
                        '<div class="skel-wrap">' +
                        '<div class="skel skel-row" style="width:70%"></div>' +
                        '<div class="skel skel-row" style="width:55%"></div>' +
                        '<div class="skel skel-row" style="width:65%"></div>' +
                        '<div class="skel skel-row" style="width:45%"></div>' +
                        '<div class="skel skel-row" style="width:60%"></div>' +
                        '</div>';
                }
                await loadData();
                loadMeta(); // health card / reconciliation / closures (non-blocking)

                const tabs = [
                    ['home', 'Home'],
                    ['daily', 'Daily Summary'],
                    ['past', 'Past Results'],
                    ['suggest', 'Suggestions'],
                    ['watchlist', 'Watchlist'],
                    ['checklist', 'Checklist'],
                    ['search', 'Search'],
                    ['analytics', 'Analytics'],
                ];

                const heroState = buildHeroHTML(activeTab, cache || []);

                root.innerHTML =
                    BACK_BTN_HTML +
                    '<div class="eyebrow">Ireland \u00b7 New Delhi Visa Section</div>' +
                    '<div class="titlerow"><h1>Irish Visa Decision Tracker</h1>' +
                    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                    THEME_BTN_HTML +
                    accountBtnHTML() +
                    (typeof createLanguageSelector === 'function' ? createLanguageSelector() : '') +
                    '<div class="stutter-badge"><i>\u24D8</i> Switching tabs may briefly stutter while data loads.</div></div>' +
                    '</div>' +
                    '<div class="sub">' + (cache && cache.length ? cache.length + ' decisions on record' :
                        'Awaiting data') + '</div>' +
                    '<div class="navpills" data-gooey-nav>' + tabs.map(([k, label]) => '<button type="button" class="navpill ' + (activeTab === k ?
                        'active' : '') + '" data-tab="' + k + '"><i data-lucide="' + ({home:'house',daily:'calendar-days',past:'archive',suggest:'message-circle',watchlist:'watch',checklist:'clipboard-check',search:'search',analytics:'bar-chart-2'}[k] || 'circle') + '"></i> ' + label + '</button>').join('') + '</div>' +
                    '<div class="hero" id="hero" data-id="' + activeTab + '" style="opacity:0">' +
                        '<div class="hero-body">' +
                            '<div>' +
                                '<h2 class="hero-title">' + heroState.title + '</h2>' +
                                '<div class="hero-sub">' + heroState.sub + '</div>' +
                            '</div>' +
                            '<div class="visual">' + heroState.visual + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div id="tab-body"></div>';

                tabs.forEach(([k]) => {
                    var pill = root.querySelector('.navpill[data-tab="' + k + '"]');
                    pill.addEventListener('click', function() {
                        // Trigger ripple animation
                        pill.classList.add('rippling');
                        setTimeout(function() { pill.classList.remove('rippling'); }, 520);
                        switchTab(k);
                    });
                });
                const themeToggle = document.getElementById('theme-toggle');
                if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
                const backBtn = document.getElementById('back-btn');
                if (backBtn) backBtn.addEventListener('click', function() { setTracker('home'); });
                const accountBtn = document.getElementById('account-btn');
                if (accountBtn) accountBtn.addEventListener('click', openAccountModal);
                const signoutBtn = document.getElementById('signout-btn');
                if (signoutBtn) signoutBtn.addEventListener('click', signOut);
                // Wire modal form submit handlers (guarded against double-wiring).
                var signinForm = document.getElementById('account-form-signin');
                if (signinForm && !signinForm._wired) {
                    signinForm._wired = true;
                    signinForm.addEventListener('submit', handleAccountForm);
                }
                var regForm = document.getElementById('account-form-register');
                if (regForm && !regForm._wired) {
                    regForm._wired = true;
                    regForm.addEventListener('submit', handleAccountForm);
                }
                morphHero();
                // Initial body paint: populate the active tab's content DIRECTLY
                // without the hero cross-fade dip. morphHero already faded the
                // hero in (opacity 0 → 1), so calling animateHeroSwitch here
                // would briefly dim it back to 0.4 before settling on 1 - a
                // visible flash on first page load. Subsequent tab clicks go
                // through switchTab() which uses the cross-fade as expected.
                var rows = cache || [];
                var tabBody = document.getElementById('tab-body');
                if (tabBody) {
                    if (activeTab === 'home') {
                        tabBody.innerHTML = renderHomeLayout(rows);
                        paintHomeRows();
                    } else if (activeTab === 'daily') {
                        tabBody.innerHTML = renderDailySummary(rows);
                    } else if (activeTab === 'past') {
                        tabBody.innerHTML = renderPastLayout(rows);
                        paintPastRows();
                    } else {
                        tabBody.innerHTML = renderSuggestLayout();
                    }
                }
                wireTabListeners();
                // Initial paint bypasses switchTab (no hero cross-fade dip), so
                // mark the visit here too - otherwise the "since you last
                // checked" banner would re-show on every load until a tab click.
                markVisited();
            }

            root.setAttribute('data-theme', theme);
            applyChrome();

            // Browser back/forward restores the tracker, tab and filters from
            // the URL. A tracker change needs a full render (different page),
            // a tab/filter change reuses the in-place switchTab().
            window.addEventListener('popstate', function() {
                const s = readUrlState();
                if (s.tracker !== activeTracker) {
                    activeTracker = s.tracker;
                    activeTab = s.tab;
                    homeSearchTerm = s.q;
                    pastDateFilter = s.date;
                    render();
                    return;
                }
                if (s.tab === activeTab && s.q === homeSearchTerm && s.date === pastDateFilter) return;
                activeTab = s.tab;
                homeSearchTerm = s.q;
                pastDateFilter = s.date;
                switchTab(activeTab, { noUrl: true });
            });

            render();
        })();

// Inline handlers were removed for the strict CSP. Delegation keeps the
// account modal and push test working without eval or inline event attributes.
document.addEventListener('click', function (event) {
  var target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  if (target.closest('[data-close-account]')) {
    event.preventDefault();
    if (window.closeAccountModal) window.closeAccountModal();
    return;
  }
  var tab = target.closest('[data-account-tab]');
  if (tab) {
    event.preventDefault();
    if (window.showAccountTab) window.showAccountTab(tab.getAttribute('data-account-tab'));
    return;
  }
  if (target.closest('[data-push-test]')) {
    event.preventDefault();
    if (window.sendPushTest) window.sendPushTest();
  }
});
