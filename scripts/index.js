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
            const WATCH_OFFICE_NAMES = {
                'new-delhi': 'New Delhi', beijing: 'Beijing', dublin: 'Dublin',
                'abu-dhabi': 'Abu Dhabi', abuja: 'Abuja', ankara: 'Ankara'
            };
            const WATCH_OFFICES = Object.keys(WATCH_OFFICE_NAMES);
            const WATCH_LIMIT = 10;
            const OFFICE_ARCHIVE_PREFIX = 'data/embassy-';
            const DATA_MANIFEST_URL = 'data/data_manifest.json';
            const OFFLINE_INDEX_URL = 'data/search_fallback.json';
            const OFFICE_SOURCE_URLS = {
                'new-delhi': 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
                beijing: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
                dublin: 'https://www.irishimmigration.ie/visa-decisions/',
                'abu-dhabi': 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
                abuja: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
                ankara: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/'
            };
            const OFFICE_COVERAGE = {
                'new-delhi': 'Daily published decisions',
                beijing: 'Latest published snapshot',
                dublin: 'Latest published snapshot',
                'abu-dhabi': 'Dated weekly reports',
                abuja: 'Dated weekly reports',
                ankara: 'Dated weekly reports'
            };
            // How old a report can be before a result needs an explicit warning.
            // Snapshot offices publish less often; weekly offices should not be
            // more than a fortnight behind before we qualify a result.
            const OFFICE_STALE_DAYS = {
                'new-delhi': 3,
                beijing: 35,
                dublin: 7,
                'abu-dhabi': 14,
                abuja: 14,
                ankara: 14
            };

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
            let dataVersion = 0;
            let datasetModel = null;
            let analyticsModel = null;
            let analyticsBuildScheduledVersion = 0;
            let pastLayoutCache = null;
            let pastRowsCache = null;
            let analyticsChartInstances = [];
            let analyticsChartObservers = [];

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
            function readStoredTheme() {
                try {
                    return localStorage.getItem('visa-theme') === 'dark' ? 'dark' : 'light';
                } catch (error) {
                    return 'light';
                }
            }
            let theme = readStoredTheme();

            function trackConversion(event, source) {
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
            function openAlertForResult(number, office) {
                if (!number) return;
                var safeOffice = WATCH_OFFICES.indexOf(office) !== -1 ? office : 'new-delhi';
                trackConversion('alert_telegram_click', 'lookup_result');
                switchTab('alerts');
                setTimeout(function() {
                    var form = document.getElementById('alert-form');
                    if (!form) return;
                    var app = form.querySelector('input[name="application_number"]');
                    var embassy = form.querySelector('select[name="embassy"]');
                    if (app) app.value = number;
                    if (embassy) {
                        embassy.value = safeOffice;
                        embassy.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    var focus = form.querySelector('#telegram-alert-btn');
                    if (focus) focus.focus({ preventScroll: true });
                }, 80);
            }

            // ---------------- URL state (deep-linkable views) ----------------
            // Tabs, the Home search term, and the Past date filter live in the
            // query string, so every view can be bookmarked/shared and survives
            // reloads. Tab switches push history entries; search/date updates
            // replace the current one (no per-keystroke history spam).
            const TABS = [
                { id: 'search', label: 'Search', icon: 'search' },
                { id: 'history', label: 'History', icon: 'calendar-days' },
                { id: 'alerts', label: 'Alerts', icon: 'bell' },
                { id: 'saved', label: 'Saved', icon: 'bookmark' },
                { id: 'tools', label: 'Tools', icon: 'wrench' },
                { id: 'analytics', label: 'Analytics', icon: 'bar-chart-2' },
            ];
            const KNOWN_TABS = TABS.map(function(tab) { return tab.id; });
            // Old bookmarks keep working after the eight-tab layout was
            // collapsed into six applicant-facing tabs.
            const LEGACY_TAB_ALIASES = {
                home: 'search',
                daily: 'history',
                past: 'history',
                suggest: 'alerts',
                suggestions: 'alerts',
                watchlist: 'saved',
                checklist: 'tools'
            };
            const TAB_VIEWS = { history: ['daily', 'past'], tools: ['checklist', 'vfs'] };
            function resolveTabView(tab, requested, legacyTab) {
                if ((TAB_VIEWS[tab] || []).indexOf(requested) !== -1) return requested;
                if (tab === 'history') return legacyTab === 'past' ? 'past' : 'daily';
                if (tab === 'tools') return 'checklist';
                return '';
            }
            // Top-level tracker: 'home' is the landing screen with the two
            // tracker cards, 'visa' the embassy-decisions tracker, '1g' the
            // Stamp 1G processing-date tracker. Old shared links carry only
            // ?tab=… - those resolve to 'visa' so nothing breaks.
            const KNOWN_TRACKERS = ['home', 'visa', '1g', 'permits'];
            // Which decisions the Past table can be narrowed to. Declared before
            // readUrlState() runs, because the reader restores it from the URL.
            const PAST_STATUSES = ['all', 'accepted', 'rejected'];

            function readUrlState() {
                const p = new URLSearchParams(location.search);
                const requestedTab = p.get('tab') || '';
                const tab = LEGACY_TAB_ALIASES[requestedTab] || requestedTab;
                const tracker = p.get('tracker');
                let resolved = 'home';
                if (tracker && KNOWN_TRACKERS.indexOf(tracker) !== -1) resolved = tracker;
                else if (tab && KNOWN_TABS.indexOf(tab) !== -1) resolved = 'visa';
                const requestedOffice = p.get('office');
                return {
                    tracker: resolved,
                    tab: KNOWN_TABS.indexOf(tab) !== -1 ? tab : 'search',
                    view: resolveTabView(tab, p.get('view'), requestedTab),
                    q: (p.get('q') || '').slice(0, 200),
                    office: WATCH_OFFICES.indexOf(requestedOffice) !== -1 ? requestedOffice : 'all',
                    date: (p.get('date') || '').slice(0, 10),
                    status: PAST_STATUSES.indexOf(p.get('status')) !== -1 ? p.get('status') : 'all'
                };
            }
            function syncUrl(mode) {
                const p = new URLSearchParams();
                if (activeTracker === 'visa') {
                    p.set('tracker', 'visa');
                    p.set('tab', activeTab);
                    if ((activeTab === 'history' || activeTab === 'tools') && activeView) p.set('view', activeView);
                    if (homeSearchTerm) p.set('q', homeSearchTerm);
                    if (homeSearchOffice !== 'all') p.set('office', homeSearchOffice);
                    if (activeTab === 'history' && activeView === 'past' && pastDateFilter) p.set('date', pastDateFilter);
                    if (activeTab === 'history' && activeView === 'past' && pastStatusFilter !== 'all') p.set('status', pastStatusFilter);
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
            let activeView = urlState.view;
            let homeSearchTerm = urlState.q;
            let homeSearchOffice = urlState.office;
            let homeLookupSeq = 0;
            let pastDateFilter = urlState.date;
            // Kept beside the date filter: the two narrow the same rows and share
            // the URL - ?tab=past&status=accepted&date=2026-10-01.
            let pastStatusFilter = urlState.status;
            let pastPageSize = 100;
            let pastVisibleLimit = 100;
            let dailyVisibleLimit = 21;
            const DAILY_PAGE_SIZE = 21;

            // ---- visit tracking + stale-data state ----
            let lastVisitAt = 0;
            try { lastVisitAt = Number(localStorage.getItem('visa-last-visit') || '0') || 0; } catch (error) { /* private mode */ }
            let visited = false;
            let staleAt = null; // data being shown is from this timestamp (live refresh failed)
            let dataLoadError = false;
            let officeWatchData = Object.create(null);
            // Change badges are computed once per page visit, then the stored
            // baseline is advanced. A later repaint in the same visit keeps the
            // badge instead of silently dropping it.
            let watchVisitChanges = Object.create(null);
            const WATCH_SEEN_KEY = 'visa-watchlist-seen';
            let officeWatchPromises = Object.create(null);
            let officeLookupMeta = null;
            let officeLookupMetaPromise = null;
            let offlineSearchIndex = null;
            let offlineSearchIndexPromise = null;

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
                if (r._preloaded) return r;
                r._preloaded = true;
                const c = classify(r.decision);
                r._status = c;
                r._pillClass = c === 'accepted' ? 'green' : c === 'rejected' ? 'red' : 'amber';
                r._placeholder = isPlaceholderRow(r);
                
                // Visa type detection is metadata used by aggregates. Row HTML
                // is deliberately built only for rows that are actually painted.
                if (!r._placeholder && r.irl) {
                    const detection = detectVisaType(r.irl, r.embassy);
                    r._visaType = detection.type;
                    r._visaSubtype = detection.subtype;
                    r._visaConfidence = detection.confidence;
                }
                return r;
            }

            function rowHTML(r) {
                var dateLabel = humanDate(r.date);
                var dateCell = '<time datetime="' + escapeHtml(r.date) + '">' + escapeHtml(dateLabel) + '</time>';
                if (r._placeholder) {
                    // Notice rows render their message, not an application number.
                    return '<tr class="ph-row"><td class="mono">' + dateCell + '</td><td colspan="2">' +
                        placeholderNote(r.decision) + '</td></tr>';
                }
                return '<tr><td class="mono">' + dateCell + '</td><td class="mono">' + r.irl +
                    '</td><td><span class="pill ' + r._pillClass + '">' + (r.decision || '-') + '</span></td></tr>';
            }

            function escapeHtml(value) {
                return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[ch]));
            }

            const _pctFmt = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });
            function fmtPct(n) { return isFinite(n) ? _pctFmt.format(n) : '-'; }
            function humanDate(value) { return lookupFormatDate(value) || String(value || ''); }
            function sampleSizeText(n, suffix) {
                var count = Number(n || 0).toLocaleString();
                var noun = n === 1 ? 'published decision' : 'published decisions';
                return (n ? 'Based on ' + count + ' ' + noun : 'No published decisions') +
                    (suffix ? ' ' + suffix : '');
            }
            // Localised short month names for the hero date ranges (no hardcoded
            // month arrays - Intl.DateTimeFormat owns locale + format).
            const _monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' });
            function shortMonth(d) { return _monthFmt.format(d); }

            function weekdayLong(dateStr) {
                const d = new Date(dateStr + 'T00:00:00');
                return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            }

            // ---- Timezone display helpers ----
            // The shared time-mode module defaults to UTC and can switch every
            // clock to local time. New Delhi schedule times are wall-clock
            // values in Asia/Kolkata; the module converts them through Intl so
            // offset and daylight-saving rules stay current.
            const NEW_DELHI_UPDATE_HOUR = 11;
            const NEW_DELHI_UPDATE_MINUTE = 0;
            const NEW_DELHI_FOLLOW_UP_MINUTE = 15;

            // All clock KPIs go through the shared time-mode module. It renders
            // <time> nodes that can switch between UTC and the visitor's local
            // zone in place, without rebuilding the current tab or results.
            function fallbackTime(value, preset) {
                const date = value instanceof Date ? value : new Date(value);
                if (Number.isNaN(date.getTime())) return 'Not recorded';
                const format = preset === 'time'
                    ? { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' }
                    : { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' };
                return date.toLocaleString('en-GB', format) + ' UTC';
            }
            function timeNode(value, preset) {
                return window.IVTimeMode
                    ? window.IVTimeMode.node(value, preset)
                    : escapeHtml(fallbackTime(value, preset));
            }
            function newDelhiTimeNode(value, preset) {
                return window.IVTimeMode
                    ? window.IVTimeMode.newDelhiNode(value, preset)
                    : escapeHtml(String(value || 'Not recorded'));
            }
            function scheduleTimeNode(hour, minute, preset) {
                if (window.IVTimeMode) return window.IVTimeMode.scheduleNode(hour, minute, preset || 'time');
                return escapeHtml(String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ' IST');
            }
            function newDelhiNow() {
                return window.IVTimeMode && window.IVTimeMode.newDelhiParts
                    ? window.IVTimeMode.newDelhiParts(new Date())
                    : null;
            }

            // ---- Home status lines: publish-time awareness + since-last-visit ----
            // New Delhi's reporting day and schedule are evaluated in its own
            // wall clock, then displayed in the zone selected by the visitor.
            function publishStatusHTML(rows) {
                const newDelhiNowValue = newDelhiNow();
                if (!newDelhiNowValue) return '';
                const newDelhiDate = newDelhiNowValue.date;
                const wd = newDelhiNowValue.weekdayIndex;
                if (wd === 0 || wd === 6) {
                    return '<div class="status-line">Embassy closed today (' + weekdayLong(newDelhiDate) +
                        '). The next file is expected Monday after <strong>' +
                        scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_UPDATE_MINUTE) + '</strong>.</div>';
                }
                const todayReal = rows.filter(r => !r._placeholder && r.date === newDelhiDate);
                if (todayReal.length) {
                    return '<div class="status-line pub-live">Today\u2019s file: <strong>published</strong>, ' +
                        todayReal.length + ' decision' + (todayReal.length === 1 ? '' : 's') + ' recorded today.</div>';
                }
                const now = new Date();
                const newDelhiMinutes = newDelhiNowValue.hour * 60 + newDelhiNowValue.minute;
                if (newDelhiMinutes < NEW_DELHI_UPDATE_HOUR * 60 + NEW_DELHI_UPDATE_MINUTE) {
                    return '<div class="status-line">Today\u2019s file: <strong>expected at ' +
                        scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_UPDATE_MINUTE) +
                        '</strong> (now ' + timeNode(now, 'time') + ').</div>';
                }
                return '<div class="status-line pub-late">Today\u2019s file: <strong>not published yet</strong>. ' +
                    'It usually appears by ' + scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_UPDATE_MINUTE) +
                    '; check back after ' + scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_FOLLOW_UP_MINUTE) + '.</div>';
            }
            function newDelhiDateStr(ts) {
                const parts = window.IVTimeMode && window.IVTimeMode.newDelhiParts
                    ? window.IVTimeMode.newDelhiParts(new Date(ts))
                    : null;
                if (parts) return parts.date;
                // Fallback for a page that loaded before the shared module.
                const d = new Date(ts);
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return d.getFullYear() + '-' + m + '-' + day;
            }
            function sinceBannerHTML(rows) {
                if (!lastVisitAt) return '';
                const fresh = rows.filter(r => !r._placeholder && r.date > newDelhiDateStr(lastVisitAt));
                if (!fresh.length) return '';
                const refused = fresh.filter(r => classify(r.decision) === 'rejected').length;
                const when = timeNode(lastVisitAt, 'weekday');
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
                const when = timeNode(staleAt, 'short');
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
                // The scraper stores an IST wall clock; the shared formatter
                // converts it to the selected display zone.
                return newDelhiTimeNode(s, 'short');
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
                const newDelhiNowValue = newDelhiNow();
                const today = newDelhiNowValue ? newDelhiNowValue.date : '';
                const isToday = Boolean(today) && String(m.lastRunAt).slice(0, 10) === today;
                let dot = 'ok', health;
                if (m.ok === false) {
                    dot = 'bad';
                    health = 'Last updated check <strong>failed</strong> (' + fmtISTStamp(m.lastRunAt) + ')';
                } else if (isToday) {
                    health = 'Last updated: <strong>' + fmtISTStamp(m.lastRunAt) + '</strong>' +
                        (m.newRows ? ' \u00b7 <strong>' + m.newRows + ' new</strong> rows' : ' \u00b7 no new rows');
                } else {
                    dot = 'stale';
                    health = 'Last updated: <strong>' + fmtISTStamp(m.lastRunAt) + '</strong>. Nothing recorded today yet.';
                }
                health += ' \u00b7 Next expected New Delhi update: a weekday around ' +
                    scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_UPDATE_MINUTE) + '.';
                html.push('<div class="meta-line"><span class="meta-dot ' + dot + '" aria-hidden="true"></span><span>' + health + '</span></div>');
                const latestDataDate = (cache || []).reduce(function(latest, row) {
                    return row && !row._placeholder && row.date && row.date > latest ? row.date : latest;
                }, '');
                const dataRows = (cache || []).filter(function(row) { return row && !row._placeholder; }).length;
                if (m.fileRows && m.sheetRows && (!latestDataDate || m.fileDate === latestDataDate)) {
                    const synced = m.sheetRows >= m.fileRows;
                    html.push('<div class="meta-line">Recorded <strong>' + m.sheetRows + '</strong> of <strong>' + m.fileRows +
                        '</strong> decisions in the latest file' + (m.fileDate ? ' (dated ' + humanDate(m.fileDate) + ')' : '') +
                        (synced ? '. Fully synced.' : '. ' + (m.fileRows - m.sheetRows) + ' still missing.') + '</div>');
                } else if (latestDataDate) {
                    // The scraper meta can lag the decisions file by a run. Show
                    // the actual newest row rather than pairing a stale file date
                    // with a newer sheet count.
                    html.push('<div class="meta-line">Tracker contains <strong>' + dataRows +
                        '</strong> published decisions, latest dated <strong>' + humanDate(latestDataDate) + '</strong>.</div>');
                }
                if (m.closureDates && m.closureDates.length) {
                    const chips = fmtClosureDates(m.closureDates).split(', ').map(c =>
                        '<span class="closure-chip">' + escapeHtml(c) + '</span>').join('');
                    html.push('<div class="meta-line">Embassy closed: <span class="closure-chips">' + chips + '</span></div>');
                }
                box.innerHTML = '<div class="meta-card">' + html.join('') + '</div>';
            }

            function localIsoDate(date) {
                return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') +
                    '-' + String(date.getDate()).padStart(2, '0');
            }

            // One read-only summary per dataset. Every tab uses this instead of
            // re-filtering and re-grouping the full history on each paint.
            function buildDatasetModel(rows, version) {
                const byDateMap = new Map();
                const real = [];
                const realByDate = new Map();
                const acceptedByDate = new Map();
                const rejectedByDate = new Map();
                for (const r of rows) {
                    if (!byDateMap.has(r.date)) byDateMap.set(r.date, []);
                    byDateMap.get(r.date).push(r);
                    if (r._placeholder) continue;
                    real.push(r);
                    if (!realByDate.has(r.date)) {
                        realByDate.set(r.date, []);
                        acceptedByDate.set(r.date, 0);
                        rejectedByDate.set(r.date, 0);
                    }
                    realByDate.get(r.date).push(r);
                    if (r._status === 'accepted') acceptedByDate.set(r.date, acceptedByDate.get(r.date) + 1);
                    else if (r._status === 'rejected') rejectedByDate.set(r.date, rejectedByDate.get(r.date) + 1);
                }
                const byDate = [...byDateMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));

                // Decision rows are dated in New Delhi, so rolling windows
                // must use that wall-clock date rather than the visitor's local
                // date. A visitor in Los Angeles can otherwise gain or lose a
                // day at the window boundary.
                const newDelhiToday = newDelhiNow();
                const today = newDelhiToday
                    ? newDelhiToday.date
                    : localIsoDate(new Date());
                function cutoff(days) {
                    const d = new Date(today + 'T00:00:00Z');
                    d.setUTCDate(d.getUTCDate() - days);
                    return d.toISOString().slice(0, 10);
                }
                const cutoff7 = cutoff(7);
                const cutoff14 = cutoff(14);
                const cutoff30 = cutoff(30);

                let accepted = 0;
                let rejected = 0;
                let last7 = 0;
                let last7Accepted = 0;
                let last30 = 0;
                let last30Accepted = 0;
                let thisWeek = 0;
                let previousWeek = 0;
                for (const r of real) {
                    if (r._status === 'accepted') {
                        accepted += 1;
                        if (r.date > cutoff7) last7Accepted += 1;
                        if (r.date > cutoff30) last30Accepted += 1;
                    } else if (r._status === 'rejected') {
                        rejected += 1;
                    }
                    if (r.date > cutoff7) {
                        last7 += 1;
                        thisWeek += 1;
                    } else if (r.date > cutoff14) {
                        previousWeek += 1;
                    }
                    if (r.date > cutoff30) last30 += 1;
                }

                let latestRealDay = null;
                let latestCount = 0;
                let previousRealCount = 0;
                let averageSum = 0;
                let averageDays = 0;
                for (const entry of byDate) {
                    const count = realByDate.get(entry[0]) ? realByDate.get(entry[0]).length : 0;
                    if (count) {
                        if (!latestRealDay) {
                            latestRealDay = entry;
                            latestCount = count;
                        } else if (!previousRealCount) {
                            previousRealCount = count;
                        }
                        if (entry[0] !== EXCLUDE_FROM_AVERAGES) {
                            averageSum += count;
                            averageDays += 1;
                        }
                    }
                }
                const latestDay = byDate.length ? byDate[0] : null;
                const latestPlaceholder = latestDay && !(realByDate.get(latestDay[0]) || []).length
                    ? latestDay[1][0] : null;

                return {
                    version,
                    rows,
                    byDate,
                    byDateMap,
                    real,
                    realByDate,
                    acceptedByDate,
                    rejectedByDate,
                    total: real.length,
                    accepted,
                    rejected,
                    last7,
                    last7Accepted,
                    last30,
                    last30Accepted,
                    thisWeek,
                    previousWeek,
                    wow: previousWeek ? (thisWeek - previousWeek) / previousWeek : null,
                    averageDaily: averageDays ? averageSum / averageDays : 0,
                    latestDay,
                    latestRealDay,
                    latestCount,
                    previousRealCount,
                    latestPlaceholder
                };
            }

            function getDatasetModel(rows) {
                if (datasetModel && datasetModel.version === dataVersion && datasetModel.rows === rows) return datasetModel;
                datasetModel = buildDatasetModel(rows || [], dataVersion);
                return datasetModel;
            }

            function invalidateDataModels() {
                datasetModel = null;
                analyticsModel = null;
                pastLayoutCache = null;
                pastRowsCache = null;
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
                        dataLoadError = false;
                        persistSnapshot(raw);
                        // Pre-compute classify + row HTML once per row, then sort by
                        // date desc so render paths are pure filter + string concat.
                        cache = raw.map(r => preloadRow(Array.isArray(r) ? { date: r[0], irl: r[1], decision: r[2] } : r));
                        cache.sort((a, b) => b.date.localeCompare(a.date));
                        cacheFetchedAt = Date.now();
                        dataVersion += 1;
                        invalidateDataModels();
                        scheduleAnalyticsModel();
                    } catch (e) {
                        console.warn('loadData failed:', e);
                        dataLoadError = true;
                        const snap = await restoreSnapshot();
                        if (snap) {
                            cache = snap.rows.map(r => preloadRow(Array.isArray(r) ? { date: r[0], irl: r[1], decision: r[2] } : r));
                            cache.sort((a, b) => b.date.localeCompare(a.date));
                            cacheFetchedAt = snap.fetchedAt;
                            staleAt = snap.fetchedAt;
                            dataVersion += 1;
                            invalidateDataModels();
                            scheduleAnalyticsModel();
                        } else if (cache === null) cache = [];
                    } finally {
                        dataPromise = null;
                        if (document.getElementById('watch-local-rows')) paintWatchlist();
                    }
                    return cache;
                })();
                return dataPromise;
            }


            function searchIcon() {
                return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
            }

            function officeName(slug) {
                return WATCH_OFFICE_NAMES[slug] || slug || '';
            }

            // Visa applicants are targeted by payment, OTP and fake-agent scams.
            // Keep this notice on every result, checklist and alert surface; the
            // tracker itself never needs a passport copy, payment or one-time code.
            function safetyNoticeHTML() {
                var sources = WATCH_OFFICES.map(function(office) {
                    var url = OFFICE_SOURCE_URLS[office];
                    return url
                        ? '<li><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
                            escapeHtml(WATCH_OFFICE_NAMES[office]) + '</a></li>'
                        : '';
                }).join('');
                return '<aside class="safety-notice" role="note" aria-label="Fraud warning">' +
                    '<p class="safety-lead"><strong>This tracker will never ask for payment, OTPs, or passport copies.</strong> ' +
                    'A decision is published by the visa office, not released by a “helper”. Do not pay anyone to reveal a decision ' +
                    'or to speed up an application.</p>' +
                    '<details class="safety-sources"><summary>Check an official office source</summary>' +
                    '<p>Confirm the application and decision on the office’s own page, or with the VFS centre that handled your application.</p>' +
                    '<ul>' + sources + '</ul></details>' +
                    '</aside>';
            }

            function officeOptionsHTML(selected) {
                selected = selected === 'all' || WATCH_OFFICES.indexOf(selected) !== -1 ? selected : 'all';
                return '<option value="all"' + (selected === 'all' ? ' selected' : '') +
                    '>All six offices</option>' +
                    WATCH_OFFICES.map(function(office) {
                        return '<option value="' + escapeHtml(office) + '"' +
                            (selected === office ? ' selected' : '') + '>' +
                            escapeHtml(officeName(office)) + '</option>';
                    }).join('');
            }

            // ===== hero builder (Mockup C) - per-tab hero with real data =====
            function buildHeroHTML(tabId, rows) {
                const model = getDatasetModel(rows);
                const byDate = model.byDate;
                const total = model.total;
                const accepted = model.accepted;
                const rejected = model.rejected;
                const accPct = total ? accepted / total : 0;
                const rejPct = total ? rejected / total : 0;
                const avg = model.averageDaily;
                // The newest day on record may be a placeholder notice; the
                // snapshot therefore comes from the newest day with real data.
                const latestPlaceholder = model.latestPlaceholder;
                const latestCount = model.latestCount;
                const dayDiff = model.latestRealDay ? latestCount - model.previousRealCount : 0;

                const states = {
                    search: {
                        title: 'One number. Six offices.',
                        sub: 'Search the published reports, then check the decision date, report date and official source.',
                        visual: '<div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="ring-core"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>'
                    },
                    history: {
                        title: 'Every published day, in one place.',
                        sub: (function() {
                            return byDate.length + ' days on record, ' + fmtPct(accPct) + ' accepted across ' + total.toLocaleString() + ' decisions.';
                        })(),
                        visual: '<div class="wave">' + byDate.slice(0, 7).reverse().map(function(d) {
                            var n = (model.realByDate.get(d[0]) || []).length;
                            return '<div class="wave-bar" style="height:' + Math.max(8, Math.min(120, n)) + 'px"></div>';
                        }).join('') + '</div>'
                    },
                    saved: {
                        title: 'Your applications, on this device.',
                        sub: 'Save a number, restore a backup, and choose which saved applications get browser push.',
                        visual: '<div class="paper"><div class="paper-title">Saved</div><div class="paper-text">No account. No server-side watchlist.</div></div>'
                    },
                    tools: {
                        title: 'Checklists and VFS, together.',
                        sub: 'Build a document checklist, print it, or open the official VFS handoff.',
                        visual: '<div class="paper"><div class="paper-title">Tools</div><div class="paper-text">Plan before you apply. This page cannot book a VFS slot.</div></div>'
                    },
                    analytics: {
                        title: 'Patterns, not predictions.',
                        sub: 'Weekly volumes, approval shares with sample sizes, and experimental unusual-pattern checks.',
                        visual: '<div class="paper"><div class="paper-title">Analytics</div><div class="paper-text">Published decisions only. Approval share is not your personal chance.</div></div>'
                    },
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
                            var counts = weekDays.map(function(d) { return (model.realByDate.get(d[0]) || []).length; });
                            var maxApps = Math.max.apply(null, counts.concat([1]));
                            return '<div class="wave">' + counts.map(function(count, i) {
                                return '<div class="wave-bar" style="height:' + Math.max(8, (count / maxApps) * 120) + 'px; animation-delay:' + (i * 0.07) + 's"></div>';
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
                                return (model.acceptedByDate.get(d[0]) || 0) + (model.rejectedByDate.get(d[0]) || 0);
                            }).concat([1]));
                            var scale = Math.min(1, 104 / Math.max(maxVal, 1));
                            var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                            return '<div class="wf">' + last7.map(function(d, i) {
                                var acc = model.acceptedByDate.get(d[0]) || 0;
                                var rej = model.rejectedByDate.get(d[0]) || 0;
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
                    alerts: {
                        title: 'Decisions, delivered.',
                        sub: 'Choose Telegram or browser push when a decision is published.',
                        visual: '<div class="paper"><div class="paper-title">Alerts</div><div class="paper-text">One message per published decision.</div></div>'
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
                var state = buildHeroHTML(tabId, rows);
                var token = (hero._switchToken || 0) + 1;
                hero._switchToken = token;
                hero.setAttribute('data-id', tabId);
                hero.querySelector('.hero-title').innerHTML = state.title;
                hero.querySelector('.hero-sub').textContent = state.sub;
                hero.querySelector('.visual').innerHTML = state.visual;
                hero.style.transition = 'opacity 0.12s ease';
                hero.style.opacity = '0.65';
                requestAnimationFrame(function() {
                    requestAnimationFrame(function() {
                        if (token === hero._switchToken) hero.style.opacity = '1';
                    });
                });
            }

            var _searchDebounce = null;

            function wireTabListeners() {
                ensureScrollableFocusable();
                if (document.getElementById('search-form')) wireSearchForm();
                var historySwitch = document.getElementById('tab-body');
                if (historySwitch) {
                    historySwitch.onclick = function(e) {
                        var historyBtn = e.target.closest && e.target.closest('[data-history-view]');
                        if (historyBtn) {
                            activeView = historyBtn.getAttribute('data-history-view');
                            switchTab('history');
                            return;
                        }
                        var toolsBtn = e.target.closest && e.target.closest('[data-tools-view]');
                        if (toolsBtn) {
                            activeView = toolsBtn.getAttribute('data-tools-view');
                            switchTab('tools');
                            return;
                        }
                        var advancedLink = e.target.closest && e.target.closest('[data-open-advanced]');
                        if (advancedLink) {
                            var advanced = document.getElementById('advanced-search');
                            if (advanced) advanced.open = true;
                            return;
                        }
                        var showMore = e.target.closest && e.target.closest('#past-show-more-btn');
                        if (showMore) {
                            pastVisibleLimit += pastPageSize;
                            paintPastRows();
                            return;
                        }
                        var dailyMore = e.target.closest && e.target.closest('[data-daily-show-more]');
                        if (dailyMore) {
                            dailyVisibleLimit += DAILY_PAGE_SIZE;
                            var dailyView = document.getElementById('daily-view');
                            if (dailyView && cache) dailyView.innerHTML = renderDailySummary(cache);
                            return;
                        }
                    };
                }
                var homeSearchEl = document.getElementById('home-search');
                if (homeSearchEl) {
                    homeSearchEl.addEventListener('input', function(e) {
                        homeSearchTerm = e.target.value;
                        var clearBtn = document.getElementById('home-search-clear');
                        if (clearBtn && !clearBtn.getAttribute('data-tu-state')) clearBtn.hidden = !homeSearchTerm.trim();
                        // Debounce so rapid typing coalesces into a single repaint.
                        if (_searchDebounce) clearTimeout(_searchDebounce);
                        _searchDebounce = setTimeout(function() {
                            _searchDebounce = null;
                            if (activeTab === 'search') runHomeLookup();
                            syncUrl('replace');
                        }, 150);
                    });
                    // A committed search (Enter or leaving the field) is kept in
                    // the "Recent:" chips below the search bar.
                    homeSearchEl.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            if (_searchDebounce) {
                                clearTimeout(_searchDebounce);
                                _searchDebounce = null;
                            }
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
                    if (activeTab === 'search' && document.body.dataset.env !== 'touch') {
                        homeSearchEl.focus();
                        homeSearchEl.setSelectionRange(homeSearchEl.value.length, homeSearchEl.value.length);
                    }
                    if (homeSearchTerm.trim()) runHomeLookup();
                }
                var homeLookupForm = document.getElementById('home-lookup-form');
                if (homeLookupForm) homeLookupForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    // Enter submits the form; cancel the input debounce so it
                    // cannot issue a second lookup and repaint over the result.
                    if (_searchDebounce) {
                        clearTimeout(_searchDebounce);
                        _searchDebounce = null;
                    }
                    if (!homeSearchTerm.trim()) {
                        var emptyInput = document.getElementById('home-search');
                        if (emptyInput) emptyInput.focus();
                        return;
                    }
                    saveRecentSearch(homeSearchTerm);
                    refreshRecentChips();
                    if (homeSearchTerm.trim().length >= 6) trackConversion('application_search', 'home');
                    runHomeLookup();
                    syncUrl('replace');
                });
                var homeOfficeEl = document.getElementById('home-office');
                if (homeOfficeEl) homeOfficeEl.addEventListener('change', function(e) {
                    var nextOffice = e.target.value;
                    homeSearchOffice = nextOffice === 'all' || WATCH_OFFICES.indexOf(nextOffice) !== -1
                        ? nextOffice : 'all';
                    if (homeSearchTerm.trim()) runHomeLookup();
                    syncUrl('replace');
                });
                var lookupResults = document.getElementById('home-lookup-results');
                if (lookupResults) lookupResults.onclick = function(e) {
                    var target = e.target && e.target.closest ? e.target : null;
                    var retry = target && target.closest('[data-home-retry]');
                    if (retry) {
                        runHomeLookup();
                        return;
                    }
                    var shareBtn = target && target.closest('[data-lookup-share]');
                    if (shareBtn) {
                        shareLookupResult(shareBtn);
                        return;
                    }
                    var watchBtn = target && target.closest('[data-lookup-watch]');
                    if (watchBtn) {
                        handleLookupWatch(watchBtn);
                        return;
                    }
                    var alertBtn = target && target.closest('[data-lookup-alert]');
                    if (alertBtn) {
                        openAlertForResult(
                            alertBtn.getAttribute('data-lookup-alert'),
                            alertBtn.getAttribute('data-lookup-alert-office')
                        );
                        return;
                    }
                    var noResultWatch = target && target.closest('[data-home-noresult-watch]');
                    if (noResultWatch) {
                        handleNoResultWatch(noResultWatch);
                        return;
                    }
                    var noResultAlert = target && target.closest('[data-home-noresult-alert]');
                    if (noResultAlert) {
                        handleNoResultAlert(noResultAlert);
                        return;
                    }
                    var allOffices = target && target.closest('[data-home-office-all]');
                    if (!allOffices) return;
                    homeSearchOffice = 'all';
                    var officeSelect = document.getElementById('home-office');
                    if (officeSelect) officeSelect.value = 'all';
                    runHomeLookup();
                    syncUrl('replace');
                };
                if (lookupResults) lookupResults.onchange = function(e) {
                    var select = e.target && e.target.closest ? e.target.closest('[data-home-noresult-office]') : null;
                    if (!select) return;
                    var watchBtn = lookupResults.querySelector('[data-home-noresult-watch]');
                    if (watchBtn) noResultWatchButtonState(watchBtn, watchBtn.getAttribute('data-home-noresult-watch'));
                };
                var dateFilterEl = document.getElementById('past-date-filter');
                if (dateFilterEl) dateFilterEl.addEventListener('change', function(e) {
                    pastDateFilter = e.target.value;
                    pastVisibleLimit = pastPageSize;
                    // Toggle .has-filter on the datefilter wrapper so the X clear
                    // button appears/disappears WITHOUT re-rendering the whole
                    // past layout (the button is always in the DOM, just hidden).
                    if (dateFilterEl.parentElement) {
                        dateFilterEl.parentElement.classList.toggle('has-filter', !!pastDateFilter);
                    }
                    if (activeTab === 'history' && activeView === 'past') paintPastRows();
                    syncUrl('replace');
                });
                var statusHost = document.getElementById('past-status-filter');
                if (statusHost) {
                    statusHost.addEventListener('change', function() {
                        pastStatusFilter = PAST_STATUSES.indexOf(statusHost.value) === -1 ? 'all' : statusHost.value;
                        pastVisibleLimit = pastPageSize;
                        paintPastRows();
                        syncUrl('replace');
                    });
                }
                var pageSizeEl = document.getElementById('past-page-size');
                if (pageSizeEl) pageSizeEl.addEventListener('change', function(e) {
                    var next = Number(e.target.value);
                    pastPageSize = [50, 100, 250, 500].indexOf(next) !== -1 ? next : 100;
                    pastVisibleLimit = pastPageSize;
                    if (activeTab === 'history' && activeView === 'past') paintPastRows();
                });
                var pastReset = document.getElementById('past-reset');
                if (pastReset) pastReset.addEventListener('click', function() {
                    pastDateFilter = '';
                    pastStatusFilter = 'all';
                    pastVisibleLimit = pastPageSize;
                    var dateInput = document.getElementById('past-date-filter');
                    if (dateInput) dateInput.value = '';
                    var dateWrap = dateInput && dateInput.parentElement;
                    if (dateWrap) dateWrap.classList.remove('has-filter');
                    var statusHost = document.getElementById('past-status-filter');
                    if (statusHost) statusHost.value = 'all';
                    if (activeTab === 'history' && activeView === 'past') {
                        switchTab('history', { noUrl: true });
                    }
                    syncUrl('replace');
                });
                var dateClearEl = document.getElementById('past-date-clear');
                if (dateClearEl) dateClearEl.addEventListener('click', function() {
                    pastDateFilter = '';
                    pastVisibleLimit = pastPageSize;
                    var dateInput = document.getElementById('past-date-filter');
                    if (dateInput) dateInput.value = '';
                    if (dateClearEl.parentElement) {
                        dateClearEl.parentElement.classList.remove('has-filter');
                    }
                    if (activeTab === 'history' && activeView === 'past') paintPastRows();
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
                // Telegram is the primary alert channel. Browser push is
                // enabled per saved application in the second Alerts card.
                var alertForm = document.getElementById('alert-form');
                if (alertForm) alertForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    startTelegramAlerts();
                });
                var alertsPushList = document.getElementById('alerts-push-list');
                if (alertsPushList) alertsPushList.onclick = function(e) {
                    var pushBtn = e.target && e.target.closest ? e.target.closest('[data-alerts-push]') : null;
                    if (!pushBtn) return;
                    var app = pushBtn.getAttribute('data-alerts-push');
                    var office = pushBtn.getAttribute('data-alerts-push-office');
                    var status = document.getElementById('alerts-push-status');
                    var enabled = pushBtn.getAttribute('aria-pressed') === 'true';
                    if (!app || !office) return;
                    if (typeof window.enablePushNotifications !== 'function') {
                        if (status) status.textContent = 'Browser notifications are not available.';
                        return;
                    }
                    if (enabled && typeof window.disablePushNotifications !== 'function') {
                        if (status) status.textContent = 'Browser notifications cannot be turned off here.';
                        return;
                    }
                    pushBtn.disabled = true;
                    if (status) {
                        status.textContent = enabled ? 'Updating browser notifications\u2026' : 'Requesting notification permission\u2026';
                        status.style.color = 'var(--ink)';
                    }
                    var action = enabled
                        ? window.disablePushNotifications(app, office)
                        : window.enablePushNotifications(app, office);
                    Promise.resolve(action).then(function(result) {
                        var saved = !!(result && result.ok) && updateWatchItemPush(app, office, !enabled);
                        paintAlertsPush();
                        if (!status) return;
                        if (result && result.ok) {
                            status.textContent = enabled
                                ? 'Browser notifications turned off for ' + app + '.'
                                : (saved ? 'Browser notifications enabled for ' + app + '.'
                                    : 'Browser notifications enabled, but the setting could not be saved in this browser.');
                            status.style.color = 'var(--green)';
                        } else {
                            status.textContent = (result && result.error) || 'Could not update browser notifications.';
                            status.style.color = 'var(--red)';
                        }
                    }).catch(function() {
                        if (status) {
                            status.textContent = 'Could not update browser notifications.';
                            status.style.color = 'var(--red)';
                        }
                    }).finally(function() {
                        pushBtn.disabled = false;
                    });
                };
                // Recent-search chips re-run the search they were saved from.
                var recentRow = document.getElementById('recent-searches');
                if (recentRow) recentRow.onclick = function(e) {
                    var chip = e.target && e.target.closest ? e.target.closest('.recent-chip') : null;
                    if (!chip) return;
                    homeSearchTerm = chip.getAttribute('data-q') || '';
                    var input = document.getElementById('home-search');
                    if (input) input.value = homeSearchTerm;
                    runHomeLookup();
                    syncUrl('replace');
                };
                // The lower export controls belong to the Latest New Delhi
                // section; the all-office lookup above has its own results.
                var homeExport = document.getElementById('home-export');
                if (homeExport) homeExport.addEventListener('click', function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    exportCSV(rows, 'visa-decisions-all.csv');
                });
                
                // Excel export for Home tab
                var homeExportExcel = document.getElementById('home-export-excel');
                if (homeExportExcel) homeExportExcel.addEventListener('click', async function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    await exportExcel(rows, 'visa-decisions-all.xlsx');
                });
                
                // PDF export for Home tab
                var homeExportPDF = document.getElementById('home-export-pdf');
                if (homeExportPDF) homeExportPDF.addEventListener('click', async function() {
                    var rows = (cache || []).filter(function(r) { return !r._placeholder; });
                    await exportPDF(rows, 'visa-decisions-all.pdf');
                });
                
                // Clear search is the home view's destructive control: the query
                // is dropped immediately and the button itself holds the window.
                // It lives in the toolbar, outside the table paint, so the click
                // that clears the search is still there to bring it back.
                var homeClear = document.getElementById('home-search-clear');
                if (homeClear) {
                    homeClear.addEventListener('click', function() {
                        var input = document.getElementById('home-search');
                        homeSearchTerm = '';
                        if (input) input.value = '';
                        homeClear.hidden = true;
                        runHomeLookup();
                        syncUrl('replace');
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
                        if (!document.getElementById('tab-body')) return location.reload();
                        paintTabBody(activeTab, cache || []);
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

            // Paint one tab and its deferred content. This is the single path
            // used by initial mount, tab changes and stale-data retries.
            function paintTabBody(tabId, rows) {
                var tabBody = document.getElementById('tab-body');
                if (!tabBody) return;
                // Chart.js instances belong to the canvases being replaced.
                // Destroy them before the tab body is cleared so repeat visits
                // cannot accumulate detached charts and their observers.
                destroyAnalyticsCharts();
                if (tabId === 'search') tabBody.innerHTML = renderHomeLayout(rows);
                else if (tabId === 'history') tabBody.innerHTML = renderHistoryLayout(rows);
                else if (tabId === 'analytics') tabBody.innerHTML = renderAnalyticsLayout(rows);
                else if (tabId === 'saved') {
                    tabBody.innerHTML = renderWatchlistLayout(rows);
                    wireWatchAdd();
                    wireWatchBackup();
                } else if (tabId === 'tools') tabBody.innerHTML = renderToolsLayout();
                else if (tabId === 'alerts') tabBody.innerHTML = renderAlertsLayout();
                wireTabListeners();
                if (tabId === 'search') paintHomeRows();
                else if (tabId === 'history' && activeView === 'past') paintPastRows();
                else if (tabId === 'analytics') paintAnalyticsCharts();
                else if (tabId === 'saved') paintWatchlist();
                else if (tabId === 'alerts') paintAlertsPush();
                else if (tabId === 'tools' && activeView === 'checklist') wireChecklistForm();
                else if (tabId === 'tools' && activeView === 'vfs') wireVFSTracking();
            }

            async function switchTab(tabId, opts) {
                if (!document.getElementById('tab-body')) return;
                activeTab = tabId;
                if (tabId === 'history' || tabId === 'tools') activeView = resolveTabView(tabId, activeView);
                if (!(opts && opts.noUrl)) syncUrl('push');
                var pills = document.querySelectorAll('#visa-dash .navpill');
                for (var i = 0; i < pills.length; i++) {
                    var isActive = pills[i].getAttribute('data-tab') === tabId;
                    pills[i].classList.toggle('active', isActive);
                    if (isActive) pills[i].setAttribute('aria-current', 'page');
                    else pills[i].removeAttribute('aria-current');
                }
                var rows = cache && cache.length ? cache : await loadData();
                paintTabBody(tabId, rows);
                markVisited();
            }


            // ====== CHECKLIST TAB ======
            function renderChecklistLayout() {
                return '<div class="checklist-layout">' +
                    '<h2 class="checklist-title">Document Checklist Generator</h2>' +
                    '<p class="checklist-sub">Generate a personalized document checklist for your Irish visa application.</p>' +
                    safetyNoticeHTML() +
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
                    '<div class="checklist-field checklist-conditional" data-checklist-for="work" hidden><label for="cl-permit-type">Work permit type</label>' +
                    '<select id="cl-permit-type" name="permit_type">' +
                    '<option value="">Not applicable</option>' +
                    '<option value="critical_skills">Critical Skills</option>' +
                    '<option value="general">General</option>' +
                    '<option value="intra_company">Intra-company transfer</option>' +
                    '<option value="contractor">Contractor</option>' +
                    '<option value="sport_cultural">Sport/Cultural</option>' +
                    '</select></div>' +
                    '<div class="checklist-field checklist-conditional" data-checklist-for="work" hidden><label for="cl-regulated">Regulated profession?</label>' +
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

            function updateChecklistConditionalFields() {
                var visa = document.getElementById('cl-visa-type');
                var isWork = visa && visa.value === 'work';
                document.querySelectorAll('[data-checklist-for="work"]').forEach(function(field) {
                    field.hidden = !isWork;
                });
            }

            function wireChecklistForm() {
                var form = document.getElementById('checklist-form');
                if (!form) return;
                var visaSelect = document.getElementById('cl-visa-type');
                if (visaSelect) visaSelect.addEventListener('change', updateChecklistConditionalFields);
                updateChecklistConditionalFields();
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
                var html = '<h3>Your Document Checklist</h3>' + safetyNoticeHTML();
                var checklist = data && data.checklist;
                var groups = [];
                if (checklist && typeof checklist === 'object') {
                    if (Array.isArray(checklist.mandatory) && checklist.mandatory.length) {
                        groups.push({ title: 'Mandatory documents', items: checklist.mandatory, badge: 'Required' });
                    }
                    var conditional = Array.isArray(checklist.conditional)
                        ? checklist.conditional.filter(function(item) { return item.applicable !== false; })
                        : [];
                    if (conditional.length) {
                        groups.push({ title: 'Conditional documents', items: conditional, badge: 'If applicable' });
                    }
                    if (Array.isArray(checklist.embassy_specific) && checklist.embassy_specific.length) {
                        groups.push({ title: 'Office-specific requirements', items: checklist.embassy_specific, badge: 'Required' });
                    }
                }

                var total = groups.reduce(function(sum, group) { return sum + group.items.length; }, 0);
                if (!total) {
                    html += '<p class="note2">No checklist items returned. Try a different visa type or office.</p>';
                    container.innerHTML = html;
                    return;
                }

                if (checklist && checklist.processing_time) {
                    html += '<p class="note2" style="margin:0 0 14px;">Processing time: <strong>' +
                        escapeHtml(checklist.processing_time) + '</strong></p>';
                }
                groups.forEach(function(group) {
                    html += '<h4 style="margin:16px 0 8px;">' + escapeHtml(group.title) +
                        ' <span class="badge category">' + group.items.length + '</span></h4>';
                    html += '<ul class="checklist-items">';
                    group.items.forEach(function(item) {
                        var name = item.name || item.title || item.id || 'Document';
                        var required = group.badge
                            ? ' <span class="badge required">' + escapeHtml(group.badge) + '</span>' : '';
                        var category = item.category
                            ? ' <span class="badge category">' + escapeHtml(item.category) + '</span>' : '';
                        var description = item.description
                            ? '<div class="note2" style="margin:4px 0 0;">' + escapeHtml(item.description) + '</div>' : '';
                        html += '<li><label class="checklist-item"><input type="checkbox" class="checklist-check">' +
                            '<span><strong>' + escapeHtml(name) + '</strong>' + required + category + description + '</span></label></li>';
                    });
                    html += '</ul>';
                });
                html += '<div class="checklist-result-actions"><button type="button" class="btn" id="checklist-print">Print / save as PDF</button></div>';
                container.innerHTML = html;
                var printBtn = document.getElementById('checklist-print');
                if (printBtn) printBtn.addEventListener('click', function() { window.print(); });
            }


            // ====== HISTORY / TOOLS SUB-VIEWS ======
            function subviewSwitchHTML(name, value, choices) {
                return '<div class="view-switch" role="tablist" aria-label="' + escapeHtml(name) + '">' +
                    choices.map(function(choice) {
                        return '<button type="button" role="tab" aria-selected="' + (value === choice.id) +
                            '" class="' + (value === choice.id ? 'active' : '') + '" data-' + name + '-view="' +
                            choice.id + '">' + escapeHtml(choice.label) + '</button>';
                    }).join('') + '</div>';
            }

            function renderHistoryLayout(rows) {
                var view = activeView === 'past' ? 'past' : 'daily';
                return subviewSwitchHTML('history', view, [
                    { id: 'daily', label: 'Daily summary' },
                    { id: 'past', label: 'All decisions' }
                ]) +
                    (view === 'past' ? renderPastLayout(rows) : '<div id="daily-view">' + renderDailySummary(rows) + '</div>') +
                    '<p class="community-share-prompt">Have a timeline from your own application? <a href="/contact#share-timeline">Share it with the community</a>. It is an anecdote, not a statistical sample.</p>';
            }

            function renderToolsLayout() {
                var view = activeView === 'vfs' ? 'vfs' : 'checklist';
                return subviewSwitchHTML('tools', view, [
                    { id: 'checklist', label: 'Document checklist' },
                    { id: 'vfs', label: 'VFS tracking' }
                ]) +
                    (view === 'vfs' ? renderVFSTracking() : renderChecklistLayout());
            }

            // Advanced filters are deliberately tucked away under Search. The
            // primary lookup above is the front door; this is for power users.
            function renderAdvancedSearchPanel() {
                return '<details class="advanced-search" id="advanced-search">' +
                    '<summary>Advanced filters</summary>' +
                    '<div class="search-layout">' +
                    '<p class="search-sub">Filter the same six-office dataset by office, decision, date or application number.</p>' +
                    '<form id="search-form" class="search-form" novalidate>' +
                    '<div class="search-field"><label for="search-query">Search query</label>' +
                    '<input type="text" id="search-query" name="query" placeholder="e.g. study visa, 48850812"></div>' +
                    '<div class="search-row">' +
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
                    '</select></div>' +
                    '<div class="search-field"><label for="search-limit">Results per page</label>' +
                    '<select id="search-limit" name="limit">' +
                    '<option value="20">20</option>' +
                    '<option value="50">50</option>' +
                    '<option value="100">100</option>' +
                    '</select></div>' +
                    '<div class="search-field"><label for="search-sort">Sort by</label>' +
                    '<select id="search-sort" name="sort">' +
                    '<option value="date_desc">Date (newest first)</option>' +
                    '<option value="date_asc">Date (oldest first)</option>' +
                    '<option value="number_desc">Application number (desc)</option>' +
                    '<option value="number_asc">Application number (asc)</option>' +
                    '</select></div>' +
                    '</div>' +
                    '<div class="search-row">' +
                    '<div class="search-field"><label for="search-date-from">Decisions from</label>' +
                    '<input type="date" id="search-date-from" name="date_from"></div>' +
                    '<div class="search-field"><label for="search-date-to">Decisions to</label>' +
                    '<input type="date" id="search-date-to" name="date_to"></div>' +
                    '</div>' +
                    '<div class="search-actions">' +
                    '<button class="btn" type="submit" id="search-submit">Search</button>' +
                    '<button class="btn secondary" type="reset" id="search-reset">Reset filters</button>' +
                    '</div>' +
                    '<div class="note" id="search-status" aria-live="polite"></div>' +
                    '</form>' +
                    '<div id="search-results" class="search-results"></div>' +
                    '</div></details>';
            }

            function wireSearchForm() {
                var form = document.getElementById('search-form');
                if (!form) return;
                form.addEventListener('reset', function() {
                    setTimeout(function() {
                        var results = document.getElementById('search-results');
                        var status = document.getElementById('search-status');
                        if (results) results.innerHTML = '';
                        if (status) status.textContent = '';
                    }, 0);
                });
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
                html += safetyNoticeHTML();
                html += '<div class="search-results-table"><table class="results-table"><thead>' +
                    '<tr><th>Decision date</th><th>Application No.</th><th>Decision</th><th>Office</th><th>Report date</th><th>Official source</th></tr></thead><tbody>';
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
                        '<td class="mono"><time datetime="' + escapeHtml(r.date || '') + '">' + escapeHtml(humanDate(r.date)) + '</time></td>' +
                        '<td class="mono">' + escapeHtml(r.number || r.irl || '') + '</td>' +
                        '<td><span class="pill ' + pillClass + '">' + escapeHtml(r.decision || '') + '</span></td>' +
                        '<td>' + escapeHtml(office) + '</td>' +
                        '<td class="mono">' + escapeHtml(r.report_date ? humanDate(r.report_date) : '—') + '</td>' +
                        '<td>' + (OFFICE_SOURCE_URLS[r.embassy]
                            ? '<a href="' + escapeHtml(OFFICE_SOURCE_URLS[r.embassy]) + '" target="_blank" rel="noopener noreferrer">Open report</a>'
                            : '—') + '</td>' +
                        '</tr>';
                });
                html += '</tbody></table></div>' +
                    '<p class="note2 search-report-note">Report date is the date of the office file that published the row; decision date is the date of the individual decision. The official source link opens the office report page.</p>';
                if (data.pagination.has_more) {
                    html += '<div class="search-pagination"><button type="button" class="btn" id="search-load-more">Load more</button></div>';
                }
                container.innerHTML = html;
                var loadMore = document.getElementById('search-load-more');
                if (loadMore) {
                    loadMore.addEventListener('click', function() {
                        var form = document.getElementById('search-form');
                        var status = document.getElementById('search-status');
                        if (!form) return;
                        var fd = new FormData(form);
                        var body = {};
                        for (var pair of fd) { if (pair[1]) body[pair[0]] = pair[1]; }
                        body.offset = data.pagination.offset + data.pagination.limit;
                        loadMore.disabled = true;
                        if (status) {
                            status.textContent = 'Loading more results\u2026';
                            status.style.color = 'var(--ink)';
                        }
                        fetch('/api/search', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        }).then(function(r) {
                            if (!r.ok) throw new Error('Search failed');
                            return r.json();
                        }).then(function(newData) {
                            if (!newData.success || !newData.pagination || !Array.isArray(newData.results)) {
                                throw new Error((newData && newData.error) || 'Search failed');
                            }
                            data.pagination = newData.pagination;
                            data.results = data.results.concat(newData.results);
                            renderSearchResults(data, container);
                            var nextStatus = document.getElementById('search-status');
                            if (nextStatus) {
                                nextStatus.textContent = data.results.length + ' of ' + data.pagination.total + ' results shown.';
                                nextStatus.style.color = 'var(--green)';
                            }
                        }).catch(function() {
                            if (status) {
                                status.textContent = 'Could not load more results. Please try again.';
                                status.style.color = 'var(--red)';
                            }
                            loadMore.disabled = false;
                        });
                    });
                }
            }


            // ====== VFS TRACKING ======
            function renderVFSTracking() {
                return '<div class="vfs-tracking">' +
                    '<h3>VFS Global appointments</h3>' +
                    '<p class="note2">Track an application, or open the official booking portal. VFS shows the real calendar only after sign-in.</p>' +
                    '<form id="vfs-track-form" class="vfs-track-form" novalidate>' +
                    '<div class="vfs-field"><label for="vfs-ref">Reference Number <span class="required">*</span></label>' +
                    '<input type="text" id="vfs-ref" name="reference" required placeholder="e.g. IN1234567890" pattern="[A-Z]{2}\\d{10}"></div>' +
                    '<div class="vfs-field"><label for="vfs-lname">Last Name <span class="required">*</span></label>' +
                    '<input type="text" id="vfs-lname" name="last_name" required placeholder="Your surname"></div>' +
                    '<div class="vfs-actions" style="display:flex;gap:8px;flex-wrap:wrap">' +
                    '<a class="btn" href="https://visa.vfsglobal.com/ind/en/irl/book-an-appointment" target="_blank" rel="noopener noreferrer">Open the official VFS portal</a>' +
                    '<button class="btn secondary" type="submit">Track on VFS Global</button>' +
                    '</div>' +
                    '<div class="note" id="vfs-track-status" aria-live="polite"></div>' +
                    '</form>' +
                    '<p class="note2">VFS shows appointment slots only after signing in. This tracker cannot see, hold, or book a slot.</p>' +
                    '</div>';
            }

            function wireVFSTracking() {
                var form = document.getElementById('vfs-track-form');
                if (!form) return;
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    var ref = document.getElementById('vfs-ref').value.trim();
                    var lname = document.getElementById('vfs-lname').value.trim();
                    var status = document.getElementById('vfs-track-status');
                    if (!ref || !lname) {
                        if (status) {
                            status.textContent = 'Enter both the reference number and last name.';
                            status.style.color = 'var(--red)';
                        }
                        (ref ? document.getElementById('vfs-lname') : document.getElementById('vfs-ref')).focus();
                        return;
                    }
                    var url = 'https://visa.vfsglobal.com/ind/en/irl/track-application' +
                        '?reference=' + encodeURIComponent(ref) +
                        '&lastName=' + encodeURIComponent(lname);
                    window.open(url, '_blank', 'noopener,noreferrer');
                    if (status) {
                        status.textContent = 'Opening VFS Global\u2026';
                        status.style.color = 'var(--green)';
                    }
                });
            }

            // ====== WATCHLIST TAB ======
            function renderWatchlistLayout() {
                return '<div class="watch-card">' +
                    '<h3 class="watch-h3">Watch an application</h3>' +
                    '<p class="note2" style="margin:0 0 12px;">Saved in this browser only. No account or sign-in is needed.</p>' +
                    '<form id="watch-add-form" novalidate>' +
                    '<div class="watch-field"><label>Application number</label>' +
                    '<input type="text" name="application_number" required inputmode="numeric" ' +
                    'autocomplete="off" maxlength="20" placeholder="e.g. IRL2026123456"></div>' +
                    '<div class="watch-field"><label>Visa office</label>' +
                    '<select name="embassy_slug">' +
                    WATCH_OFFICES.map(function(office) {
                        return '<option value="' + office + '">' + WATCH_OFFICE_NAMES[office] + '</option>';
                    }).join('') +
                    '</select></div>' +
                    '<div class="watch-field"><label>Nickname <span class="note2">(optional)</span></label>' +
                    '<input type="text" name="nickname" maxlength="60" placeholder="e.g. My study visa"></div>' +
                    '<button class="btn" type="submit" id="watch-add-btn">Save to watchlist</button>' +
                    '<div class="note" id="watch-add-status" aria-live="polite"></div>' +
                    '</form>' +
                    '</div>' +
                    '<div class="watch-card">' +
                    '<h3 class="watch-h3">Saved applications</h3>' +
                    '<div class="note2" id="watch-local-status">Checking saved applications\u2026</div>' +
                    '<div class="note2" id="watch-data-note"></div>' +
                    '<div class="watch-change-summary" id="watch-change-summary" role="status" aria-live="polite" hidden></div>' +
                    '<div id="watch-local-rows"></div>' +
                    '<p class="note2" style="margin-bottom:0;">For Telegram alerts, use the Alerts tab. Browser notifications can also be enabled per application below.</p>' +
                    '</div>' +
                    '<div class="watch-card">' +
                    '<h3 class="watch-h3">Back up this list</h3>' +
                    '<p class="note2" style="margin:0 0 10px;">Download a JSON copy or restore a previous copy. The file stays on this device.</p>' +
                    '<button type="button" class="export-btn tu-btn" id="watch-export-btn">Export watchlist</button>' +
                    '<button type="button" class="export-btn tu-btn" id="watch-import-btn">Import watchlist</button>' +
                    '<input class="visually-hidden" type="file" id="watch-import-input" accept="application/json,.json">' +
                    '<div class="note" id="watch-backup-status" aria-live="polite"></div>' +
                    '</div>';
            }

            function watchlistDataNote(list) {
                var hasNewDelhi = (list || []).some(function(item) {
                    return item.office === 'new-delhi';
                });
                if (!hasNewDelhi) return '';
                if (staleAt) {
                    return 'Showing cached New Delhi data from ' + timeNode(staleAt, 'short') + '. Live refresh failed.';
                }
                if (dataLoadError) return 'Live New Delhi decision data could not be loaded.';
                return '';
            }

            function loadOfficeWatchData(office) {
                if (office === 'new-delhi') return Promise.resolve(cache || []);
                if (officeWatchData[office] && officeWatchData[office].status !== 'loading') {
                    return Promise.resolve(officeWatchData[office].rows || []);
                }
                if (officeWatchPromises[office]) return officeWatchPromises[office];
                officeWatchData[office] = { status: 'loading', rows: [] };
                officeWatchPromises[office] = fetch(OFFICE_ARCHIVE_PREFIX + office + '.json', { cache: 'no-store' })
                    .then(function(res) {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.json();
                    })
                    .then(function(payload) {
                        var decisions = Array.isArray(payload) ? payload :
                            (payload && Array.isArray(payload.decisions) ? payload.decisions : []);
                        var rows = decisions.map(function(d) {
                            return preloadRow({
                                date: d.date, irl: d.number, decision: d.decision, embassy: office
                            });
                        }).sort(function(a, b) {
                            return String(b.date).localeCompare(String(a.date));
                        });
                        var meta = !Array.isArray(payload) && payload ? {
                            source_url: payload.source_url,
                            source_name: payload.source_name,
                            report_date: payload.report_date,
                            as_of: payload.as_of,
                            fetched_at: payload.fetched_at
                        } : null;
                        officeWatchData[office] = { status: 'ready', rows: rows, meta: meta };
                    })
                    .catch(function(error) {
                        console.warn('Office watchlist data failed for ' + office + ':', error);
                        officeWatchData[office] = { status: 'error', rows: [], meta: null };
                    })
                    .finally(function() {
                        officeWatchPromises[office] = null;
                        if (document.getElementById('watch-local-rows')) {
                            paintWatchlist();
                        }
                    });
                return officeWatchPromises[office];
            }

            function watchOfficeState(office) {
                if (office === 'new-delhi') {
                    if (cache === null) return { status: 'loading', rows: [] };
                    if (dataLoadError && !cache.length) return { status: 'error', rows: [] };
                    return { status: 'ready', rows: cache };
                }
                if (!officeWatchData[office]) loadOfficeWatchData(office);
                return officeWatchData[office] || { status: 'loading', rows: [] };
            }

            function paintWatchlist() {
                var box = document.getElementById('watch-local-rows');
                var status = document.getElementById('watch-local-status');
                var summary = document.getElementById('watch-change-summary');
                if (!box) return;
                var list = getWatchlist();
                var note = document.getElementById('watch-data-note');
                if (note) note.textContent = watchlistDataNote(list);
                if (!list.length) {
                    if (status) status.textContent = 'No saved applications yet.';
                    if (summary) { summary.hidden = true; summary.textContent = ''; }
                    box.innerHTML = '<div class="note2">Add an application above to keep it here.</div>';
                    return;
                }
                var states = {};
                var checking = false;
                list.forEach(function(item) {
                    var state = watchOfficeState(item.office);
                    states[item.office] = state;
                    if (state.status === 'loading') checking = true;
                });
                var seen = getWatchSeen();
                var changed = 0;
                var html = '<div class="table-wrap watchlist-table-wrap"><table class="results-table"><thead><tr>' +
                    '<th scope="col">Application</th><th scope="col">Office</th>' +
                    '<th scope="col">Nickname</th><th scope="col">Latest decision</th>' +
                    '<th scope="col">Date</th><th scope="col">&nbsp;</th>' +
                    '</tr></thead><tbody>';
                list.forEach(function(item) {
                    var state = states[item.office] || { status: 'loading', rows: [] };
                    var row = state.status === 'ready' ? state.rows.find(function(candidate) {
                        return watchRowMatches(candidate, item);
                    }) : null;
                    var decision;
                    var date = '\u2014';
                    var pill;
                    var change = row ? watchChangeFor(item, row, seen) : null;
                    if (change) changed++;
                    if (row) {
                        decision = escapeHtml(row.decision || '-');
                        date = '<time datetime="' + escapeHtml(row.date) + '">' + escapeHtml(humanDate(row.date)) + '</time>';
                        pill = '<span class="pill ' + (row._pillClass || 'amber') + '">' + decision + '</span>';
                        if (change) {
                            var previous = change.previous || {};
                            var previousDate = lookupFormatDate(previous.date);
                            pill += '<span class="watch-change-badge">New since your last visit</span>' +
                                '<span class="watch-change-detail">Previously ' +
                                escapeHtml(previous.decision || 'not listed') +
                                (previousDate ? ' on ' + escapeHtml(previousDate) : '') + '</span>';
                        }
                    } else {
                        decision = state.status === 'loading' ? 'Checking office data\u2026' :
                            state.status === 'error' ? 'Office data unavailable' : 'No decision found';
                        pill = '<span class="note2">' + decision + '</span>';
                    }
                    var pushLabel = item.push ? 'Push on' : 'Enable push';
                    var pushTitle = item.push ? 'Browser notifications are enabled' : 'Enable browser notifications';
                    html += '<tr data-office="' + escapeHtml(item.office) +
                        '" data-watch-number="' + escapeHtml(item.number) + '">' +
                        '<td class="mono">' + escapeHtml(item.number) + '</td>' +
                        '<td>' + escapeHtml(WATCH_OFFICE_NAMES[item.office] || item.office) + '</td>' +
                        '<td>' + escapeHtml(item.nickname || '\u2014') + '</td>' +
                        '<td>' + pill + '</td>' +
                        '<td>' + date + '</td>' +
                        '<td><button type="button" class="export-btn tu-btn" data-watch-push="' +
                        escapeHtml(item.number) + '" data-watch-office="' + escapeHtml(item.office) +
                        '" aria-pressed="' + (item.push ? 'true' : 'false') + '" title="' + pushTitle +
                        '" aria-label="' + pushTitle + ' for ' + escapeHtml(item.number) + '">' + pushLabel + '</button> ' +
                        '<button type="button" class="export-btn tu-btn" data-watch-remove="' + escapeHtml(item.number) +
                        '" data-watch-office="' + escapeHtml(item.office) +
                        '" title="Remove">Remove</button></td>' +
                        '</tr>';
                    if (row) rememberWatchSeen(item, row, seen);
                });
                saveWatchSeen(seen);
                if (status) {
                    status.textContent = checking
                        ? 'Checking saved applications\u2026'
                        : list.length + ' saved application' + (list.length === 1 ? '' : 's') +
                            (changed ? ' \u00b7 ' + changed + ' changed since your last visit' : '');
                }
                if (summary) {
                    summary.hidden = false;
                    summary.textContent = changed
                        ? changed + ' saved application' + (changed === 1 ? '' : 's') +
                            ' changed since your last visit. The previous decision is shown below.'
                        : 'No changes since your last visit.';
                }
                box.innerHTML = html + '</tbody></table></div>';
                box.onclick = function(e) {
                    var pushBtn = e.target && e.target.closest ? e.target.closest('[data-watch-push]') : null;
                    if (pushBtn) {
                        var app = pushBtn.getAttribute('data-watch-push');
                        var office = pushBtn.getAttribute('data-watch-office');
                        if (typeof window.enablePushNotifications !== 'function') {
                            if (status) status.textContent = 'Browser notifications are not available.';
                            return;
                        }
                        pushBtn.disabled = true;
                        if (status) status.textContent = 'Requesting notification permission\u2026';
                        window.enablePushNotifications(app, office).then(function(result) {
                            var saved = result.ok ? updateWatchItemPush(app, office, true) : false;
                            paintWatchlist();
                            if (status) status.textContent = result.ok
                                ? (saved ? 'Browser notifications enabled for ' + app + '.'
                                    : 'Browser notifications enabled, but the setting could not be saved in this browser.')
                                : (result.error || 'Could not enable notifications.');
                        }).finally(function() { pushBtn.disabled = false; });
                        return;
                    }
                    var removeBtn = e.target && e.target.closest ? e.target.closest('[data-watch-remove]') : null;
                    if (!removeBtn) return;
                    var removal = removeWatchItem(
                        removeBtn.getAttribute('data-watch-remove'),
                        removeBtn.getAttribute('data-watch-office')
                    );
                    if (!removal.saved) {
                        if (status) status.textContent = 'Could not remove this entry from the browser.';
                        return;
                    }
                    paintWatchlist();
                    if (removal.item) {
                        disableWatchPush(removal.item);
                        if (status) status.textContent = 'Removed from this browser.';
                    }
                };
            }

            function wireWatchAdd() {
                var form = document.getElementById('watch-add-form');
                if (!form || form.dataset.wired === '1') return;
                form.dataset.wired = '1';
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    var status = document.getElementById('watch-add-status');
                    var result = addWatchItem({
                        number: form.elements['application_number'].value,
                        office: form.elements['embassy_slug'].value,
                        nickname: form.elements['nickname'].value.trim()
                    });
                    if (result === 'invalid') {
                        if (status) { status.textContent = 'Enter a valid application number.'; status.style.color = 'var(--red)'; }
                        return;
                    }
                    if (result === 'duplicate') {
                        if (status) { status.textContent = 'That application is already saved.'; status.style.color = ''; }
                        return;
                    }
                    if (result === 'limit') {
                        if (status) { status.textContent = 'You can save up to ' + WATCH_LIMIT + ' applications in this browser.'; status.style.color = ''; }
                        return;
                    }
                    if (result === 'save-failed') {
                        if (status) { status.textContent = 'Could not save this watchlist in this browser.'; status.style.color = 'var(--red)'; }
                        return;
                    }
                    if (status) { status.textContent = 'Saved in this browser.'; status.style.color = 'var(--green)'; }
                    form.reset();
                    trackConversion('watchlist_added', 'watchlist');
                    paintWatchlist();
                });
            }

            function watchBackupStatus(message, isError) {
                var status = document.getElementById('watch-backup-status');
                if (!status) return;
                status.textContent = message;
                status.style.color = isError ? 'var(--red)' : '';
            }

            function exportWatchlist() {
                var items = getWatchlist().map(function(item) {
                    return { number: item.number, office: item.office, nickname: item.nickname };
                });
                var payload = {
                    version: 1,
                    exported_at: new Date().toISOString(),
                    watchlist: items
                };
                var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var link = document.createElement('a');
                link.href = url;
                link.download = 'irish-visa-watchlist-' + new Date().toISOString().slice(0, 10) + '.json';
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function() { URL.revokeObjectURL(url); }, 0);
                watchBackupStatus('Export started.', false);
            }

            function importWatchlistText(text) {
                var parsed;
                try {
                    parsed = JSON.parse(text);
                } catch (e) {
                    watchBackupStatus('That file is not valid JSON.', true);
                    return;
                }
                var raw = Array.isArray(parsed) ? parsed :
                    (parsed && Array.isArray(parsed.watchlist) ? parsed.watchlist : null);
                if (!raw) {
                    watchBackupStatus('That file does not contain a watchlist.', true);
                    return;
                }
                var clean = cleanWatchlist(raw);
                if (!clean.length) {
                    watchBackupStatus('That file does not contain a valid watchlist.', true);
                    return;
                }
                var old = getWatchlist();
                var oldPush = {};
                old.forEach(function(item) { oldPush[item.office + '|' + item.number] = item.push; });
                clean.forEach(function(item) {
                    if (oldPush[item.office + '|' + item.number]) item.push = true;
                });
                if (old.length && !window.confirm('Replace this browser\'s watchlist with the imported file?')) {
                    watchBackupStatus('Import cancelled.', false);
                    return;
                }
                if (!saveWatchlist(clean)) {
                    watchBackupStatus('Could not save this watchlist in this browser.', true);
                    return;
                }
                var kept = {};
                clean.forEach(function(item) { kept[item.office + '|' + item.number] = 1; });
                old.forEach(function(item) {
                    if (!kept[item.office + '|' + item.number]) disableWatchPush(item);
                });
                paintWatchlist();
                watchBackupStatus('Imported ' + clean.length + ' application' +
                    (clean.length === 1 ? '' : 's') +
                    (raw.length > clean.length ? '. Only valid entries within the ' + WATCH_LIMIT + '-item limit were kept.' : '.'), false);
            }

            function wireWatchBackup() {
                var exportBtn = document.getElementById('watch-export-btn');
                if (exportBtn && exportBtn.dataset.wired !== '1') {
                    exportBtn.dataset.wired = '1';
                    exportBtn.addEventListener('click', exportWatchlist);
                }
                var importBtn = document.getElementById('watch-import-btn');
                var input = document.getElementById('watch-import-input');
                if (!importBtn || !input || importBtn.dataset.wired === '1') return;
                importBtn.dataset.wired = '1';
                importBtn.addEventListener('click', function() { input.click(); });
                input.addEventListener('change', function() {
                    var file = input.files && input.files[0];
                    if (!file) return;
                    var reader = new FileReader();
                    reader.onload = function() {
                        importWatchlistText(String(reader.result || ''));
                        input.value = '';
                    };
                    reader.onerror = function() {
                        watchBackupStatus('Could not read that file.', true);
                        input.value = '';
                    };
                    reader.readAsText(file);
                });
            }

            // ====== HOME TAB ======
            // The lookup at the top is deliberately separate from the New Delhi
            // analytics below it. It can query every office archive without
            // changing `cache`, which the rest of the dashboard still treats as
            // the New Delhi history.
            function homeLookupHTML() {
                var status = homeSearchTerm.trim()
                    ? 'Searching published decisions\u2026'
                    : 'Choose a number and office. All six offices are searched by default.';
                return '<section class="home-lookup" aria-labelledby="home-lookup-title">' +
                    '<div class="home-lookup-head">' +
                    '<div>' +
                    '<h2 id="home-lookup-title">Find your application</h2></div>' +
                    '</div>' +
                    '<p class="home-lookup-copy" id="home-lookup-copy">Search all six offices at once. Use the application number on your receipt; an IRL prefix is optional.</p>' +
                    '<form class="home-lookup-form" id="home-lookup-form" role="search" novalidate>' +
                    '<div class="home-lookup-field home-lookup-number">' +
                    '<label for="home-search">Application number</label>' +
                    '<div class="searchbar">' + searchIcon() +
                    '<input type="text" id="home-search" name="q" inputmode="numeric" autocomplete="off" maxlength="200" aria-describedby="home-lookup-copy home-number-help" aria-label="Search by application number" placeholder="e.g. 48850812" value="' +
                    escapeHtml(homeSearchTerm) + '"></div></div>' +
                    '<div class="home-lookup-field home-lookup-office">' +
                    '<label for="home-office">Visa office</label>' +
                    '<select id="home-office" name="office" aria-label="Visa office to search">' + officeOptionsHTML(homeSearchOffice) + '</select></div>' +
                    '<button class="btn home-lookup-submit" type="submit" id="home-lookup-submit">Search</button>' +
                    '</form>' +
                    '<p class="home-lookup-coverage"><strong>Coverage:</strong> New Delhi: daily decisions &middot; Beijing and Dublin: latest snapshot &middot; Abu Dhabi, Abuja and Ankara: dated reports.</p>' +
                    '<div class="home-lookup-tools">' +
                    '<div id="recent-searches">' + recentSearchesHTML() + '</div>' +
                    '<button type="button" class="export-btn tu-btn" id="home-search-clear" title="Clear the search and show every result" hidden>Clear search</button>' +
                    '</div>' +
                    '<div class="home-lookup-help">' +
                    '<details id="home-number-help"><summary>Where do I find my application number?</summary>' +
                    '<p>Use the application number on your receipt, acknowledgement or decision email. It is usually <strong>8 digits</strong> (6&ndash;12 digits is accepted), and an <strong>IRL</strong> prefix, spaces or dashes are optional. Do not use a VFS reference number or your passport number.</p>' +
                    '<p><a href="/help#find-number">More help with numbers and missing results</a></p>' +
                    '</details>' +
                    '<a class="home-lookup-help-link" href="/help">Help &amp; FAQ</a>' +
                    '</div>' +
                    '<div class="home-lookup-status note2" id="home-lookup-status" role="status" aria-live="polite">' + status + '</div>' +
                    '<div id="home-lookup-results"></div>' +
                    '</section>';
            }

            function loadOfficeLookupMeta() {
                if (officeLookupMeta) return Promise.resolve(officeLookupMeta);
                if (officeLookupMetaPromise) return officeLookupMetaPromise;
                officeLookupMetaPromise = fetch(DATA_MANIFEST_URL, { cache: 'no-store' })
                    .then(function(res) {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.json();
                    })
                    .then(function(payload) {
                        var map = Object.create(null);
                        ((payload && payload.offices) || []).forEach(function(office) {
                            if (office && office.slug) map[office.slug] = office;
                        });
                        if (!Object.keys(map).length) throw new Error('no offices in manifest');
                        officeLookupMeta = map;
                        return map;
                    })
                    .catch(function(error) {
                        console.warn('Office lookup metadata failed:', error);
                        return Object.create(null);
                    })
                    .finally(function() {
                        officeLookupMetaPromise = null;
                    });
                return officeLookupMetaPromise;
            }

            function loadOfflineSearchIndex() {
                if (offlineSearchIndex) return Promise.resolve(offlineSearchIndex);
                if (offlineSearchIndexPromise) return offlineSearchIndexPromise;
                offlineSearchIndexPromise = fetch(OFFLINE_INDEX_URL, { cache: 'no-store' })
                    .then(function(res) {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.json();
                    })
                    .then(function(payload) {
                        if (!payload || !Array.isArray(payload.rows) || !payload.offices) {
                            throw new Error('invalid fallback index');
                        }
                        offlineSearchIndex = payload;
                        return payload;
                    })
                    .catch(function(error) {
                        console.warn('Fallback search index failed:', error);
                        offlineSearchIndexPromise = null;
                        throw error;
                    });
                return offlineSearchIndexPromise;
            }

            function prepareLookupRow(row) {
                var office = row.embassy || 'new-delhi';
                var number = normalizeIRL(row.irl || row.number) || String(row.irl || row.number || '');
                var status = classify(row.decision);
                return Object.assign({}, row, {
                    irl: row.number || row.irl || '',
                    number: number,
                    embassy: office,
                    _status: status,
                    _pillClass: status === 'accepted' ? 'green' : status === 'rejected' ? 'red' : 'amber',
                    _placeholder: false
                });
            }

            function offlineLookup(term, office) {
                var query = normalizeIRL(term);
                var raw = String(term || '').trim().toLowerCase();
                return loadOfflineSearchIndex().then(function(index) {
                    var matches = [];
                    (index.rows || []).forEach(function(row) {
                        if (!Array.isArray(row) || row.length < 4) return;
                        var slug = String(row[0] || '');
                        if (office !== 'all' && slug !== office) return;
                        var number = normalizeIRL(row[1]);
                        if (!number) return;
                        var score;
                        if (query) {
                            if (number === query) score = 0;
                            else if (number.indexOf(query) === 0) score = 1;
                            else if (number.indexOf(query) !== -1) score = 2;
                            else return;
                        } else {
                            if (String(row[3] || '').toLowerCase().indexOf(raw) === -1) return;
                            score = 3;
                        }
                        matches.push({
                            score: score,
                            row: prepareLookupRow({
                                date: row[2],
                                number: number,
                                decision: row[3],
                                embassy: slug,
                                source: (index.offices[slug] && index.offices[slug].status === 'official') ? 'official' : 'unverified',
                                report_date: index.offices[slug] && index.offices[slug].report_date
                            })
                        });
                    });
                    matches.sort(function(a, b) {
                        if (a.score !== b.score) return a.score - b.score;
                        return String(b.row.date || '').localeCompare(String(a.row.date || ''));
                    });
                    return {
                        results: matches.slice(0, 100).map(function(item) { return item.row; }),
                        total: matches.length,
                        metas: index.offices || {},
                        generated_at: index.generated_at || ''
                    };
                });
            }

            function lookupFallbackNoteHTML(fallback) {
                if (!fallback) return '';
                var generated = fallback.generated_at ? lookupFormatDate(fallback.generated_at) : '';
                return '<div class="home-lookup-fallback" role="note"><strong>Live search is unavailable.</strong> ' +
                    'Showing the tracker\u2019s local fallback index' +
                    (generated ? ' generated ' + escapeHtml(generated) : '') +
                    '. The decision cards below are still from the published office reports.</div>';
            }

            function lookupFormatDate(value) {
                var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
                if (!match) return '';
                var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
                if (isNaN(date.getTime())) return '';
                return date.toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
                });
            }

            function lookupFormatChecked(value) {
                if (!value) return 'Not recorded';
                if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
                    var day = lookupFormatDate(value);
                    return day ? escapeHtml(day) + ' (date only)' : 'Not recorded';
                }
                return timeNode(value, 'full');
            }

            function lookupOfficeMeta(office, metas) {
                var item = (metas && metas[office]) || {};
                var sourceUrl = item.source_url;
                if (!/^https?:\/\//i.test(String(sourceUrl || ''))) {
                    sourceUrl = OFFICE_SOURCE_URLS[office] || '';
                }
                if (!/^https?:\/\//i.test(String(sourceUrl || ''))) sourceUrl = '';
                var sourceFile = item.source_file;
                if (!/^https?:\/\//i.test(String(sourceFile || ''))) sourceFile = '';
                return {
                    source_url: sourceUrl,
                    source_file: sourceFile,
                    source_name: item.source_name || '',
                    report_date: item.report_date || '',
                    fetched_at: item.fetched_at || '',
                    as_of: item.as_of || '',
                    status: item.status || '',
                    note: item.note || ''
                };
            }

            function lookupReportAgeDays(value) {
                var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
                if (!match) return null;
                var report = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
                var now = new Date();
                var today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
                if (!isFinite(report)) return null;
                return Math.max(0, Math.floor((today - report) / 86400000));
            }

            function lookupFreshness(office, meta) {
                var age = lookupReportAgeDays(meta.report_date);
                var status = String(meta.status || '').toLowerCase();
                var date = lookupFormatDate(meta.report_date);
                var label = age === null
                    ? 'Report date not recorded'
                    : (age === 0 ? 'Updated today' : age === 1 ? 'Updated yesterday'
                        : (date || 'Report dated') + ' (' + age + ' days ago)');
                var warning = '';
                if (status && status !== 'official') {
                    warning = 'This office marks its latest data as "' + meta.status + '". Results may be incomplete; check the official report.';
                } else if (age === null) {
                    warning = 'The report date is unavailable. Check this row against the official report before relying on it.';
                } else if (age > (OFFICE_STALE_DAYS[office] || 14)) {
                    warning = 'This office report is ' + age + ' days old. A newer decision may not appear here yet.';
                }
                return { age: age, label: label, warning: warning, note: meta.note || '', status: status };
            }

            function lookupFreshnessHTML(office, meta) {
                var freshness = lookupFreshness(office, meta);
                var out = '<div class="lookup-result-freshness' + (freshness.warning ? ' is-warning' : '') + '"' +
                    (freshness.warning ? ' role="note"' : '') + '>' +
                    '<strong>Report freshness:</strong> ' + escapeHtml(freshness.label) + '. ';
                if (freshness.warning) out += escapeHtml(freshness.warning) + ' ';
                if (freshness.note) out += '<span class="lookup-result-source-note">' + escapeHtml(freshness.note) + '</span>';
                return out + '</div>';
            }

            function lookupWatchSaved(number, office) {
                return getWatchlist().some(function(item) {
                    return item.number === number && item.office === office;
                });
            }

            function noResultWatchButtonState(btn, number) {
                if (!btn) return;
                var office = noResultOffice();
                if (!office) return;
                var saved = lookupWatchSaved(number, office);
                btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
                btn.textContent = saved ? 'Watching' : 'Watch this number';
                btn.classList.toggle('is-saved', saved);
            }

            function lookupWatchButtonHTML(number, office) {
                var saved = lookupWatchSaved(number, office);
                return '<button type="button" class="btn lookup-result-btn lookup-result-watch' +
                    (saved ? ' is-saved' : '') + '" data-lookup-watch data-lookup-number="' +
                    escapeHtml(number) + '" data-lookup-office="' + escapeHtml(office) +
                    '" aria-pressed="' + (saved ? 'true' : 'false') + '" aria-label="' +
                    (saved ? 'Watching application ' + escapeHtml(number) + '. Remove from your watchlist'
                        : 'Watch this application: ' + escapeHtml(number)) + '" title="' +
                    (saved ? 'Remove from your watchlist' : 'Save to your watchlist') + '">' +
                    (saved ? 'Watching' : 'Watch this application') + '</button>';
            }

            function lookupNextStepsHTML(row) {
                var status = row._status || classify(row.decision);
                var steps;
                if (status === 'accepted') {
                    steps = [
                        '<strong>This application was approved in the published report.</strong> Wait for the visa office or VFS to tell you how to submit or collect your passport. Do not book travel until your passport is back with the visa.',
                        'When the visa arrives, check your name, passport number, visa dates and conditions. If anything is wrong, contact the visa office or VFS centre that handled your application.',
                        'Keep this report with your decision letter. This page is a copy of the published report, not your official decision letter.'
                    ];
                } else if (status === 'rejected') {
                    steps = [
                        '<strong>This application was refused in the published report.</strong> The report usually does not give the reason.',
                        'Read your refusal letter or decision email for the reason and any appeal or review deadline. If it has not arrived, contact the visa office or VFS centre that handled your application.',
                        'If you reapply, you will usually need a new application and fee. A new application is separate from this one.'
                    ];
                } else {
                    steps = [
                        '<strong>The published report records this decision as "' + escapeHtml(row.decision || 'not recognised') + '".</strong> Check your decision letter and the official report to confirm what it means for your application.',
                        'If the wording does not match your letter, contact the visa office or VFS centre that handled your application.',
                        'Save this application or set an alert if you want to check the report again.'
                    ];
                }
                var sourceUrl = OFFICE_SOURCE_URLS[row.embassy || 'new-delhi'];
                var links = '<p class="lookup-result-links">' +
                    (sourceUrl ? '<a href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">Official office report</a>' : '') +
                    (sourceUrl ? ' \u00b7 ' : '') +
                    '<a href="https://www.irishimmigration.ie/" target="_blank" rel="noopener noreferrer">Immigration Service Delivery</a>' +
                    ' \u00b7 <a href="https://visa.vfsglobal.com/ind/en/irl" target="_blank" rel="noopener noreferrer">VFS Global</a></p>';
                return '<div class="lookup-result-next lookup-steps">' +
                    '<h4>What to do next</h4><ol>' +
                    steps.map(function(step) { return '<li>' + step + '</li>'; }).join('') +
                    '</ol>' + links +
                    '<p class="lookup-result-disclaimer">General information, not legal advice. Check your decision letter and the official source.</p></div>';
            }

            function lookupResultCardHTML(row, metas) {
                var office = row.embassy || 'new-delhi';
                var number = normalizeIRL(row.irl || row.number) || String(row.irl || row.number || '');
                var meta = lookupOfficeMeta(office, metas);
                var decision = row.decision || 'Decision not listed';
                var reportDate = lookupFormatDate(meta.report_date);
                var decisionDate = lookupFormatDate(row.date);
                var checked = meta.fetched_at ? lookupFormatChecked(meta.fetched_at) :
                    (meta.as_of ? lookupFormatChecked(meta.as_of) : 'Not recorded');
                var sourceName = meta.source_name || ('Published report for ' + officeName(office));
                var source = meta.source_url
                    ? '<a href="' + escapeHtml(meta.source_url) + '" target="_blank" rel="noopener noreferrer">' +
                        escapeHtml(sourceName) + ' <span aria-hidden="true">\u2197</span></a>' +
                        '<span class="lookup-result-source-note">opens in a new tab</span>'
                    : '<span class="lookup-result-source-missing">Official source link is unavailable right now.</span>';
                var privacyId = 'lookup-share-privacy-' + String(number).replace(/[^A-Za-z0-9_-]/g, '') + '-' + office;
                var exactSource = meta.source_file && meta.source_file !== meta.source_url
                    ? '<p class="lookup-result-source lookup-result-source-file">' +
                        '<span class="lookup-result-source-label">Report containing this row</span>' +
                        '<a href="' + escapeHtml(meta.source_file) + '" target="_blank" rel="noopener noreferrer" data-lookup-source-file>' +
                        'Open the official report file <span aria-hidden="true">\u2197</span></a>' +
                        '<span class="lookup-result-source-note">PDF or ODS from the office</span></p>'
                    : '';
                return '<article class="lookup-result-card" data-lookup-result data-office="' +
                    escapeHtml(office) + '" data-lookup-number="' + escapeHtml(number) + '">' +
                    '<div class="lookup-result-head"><div>' +
                    '<p class="lookup-result-kicker">Published decision</p>' +
                    '<h3 class="lookup-result-title">Application <span class="mono">' + escapeHtml(number) + '</span></h3>' +
                    '</div><span class="pill ' + (row._pillClass || 'amber') + ' lookup-result-decision">' +
                    escapeHtml(decision) + '</span></div>' +
                    '<dl class="lookup-result-facts">' +
                    '<div class="lookup-result-fact"><dt>Office</dt><dd>' + escapeHtml(officeName(office)) + '</dd></div>' +
                    '<div class="lookup-result-fact"><dt>Coverage</dt><dd>' + escapeHtml(OFFICE_COVERAGE[office] || 'Published report') + '</dd></div>' +
                    '<div class="lookup-result-fact"><dt>Decision date</dt><dd>' +
                    (decisionDate ? '<time datetime="' + escapeHtml(row.date) + '">' + decisionDate + '</time>' : 'Not listed') + '</dd></div>' +
                    '<div class="lookup-result-fact"><dt>Report date</dt><dd>' +
                    (reportDate ? '<time datetime="' + escapeHtml(meta.report_date) + '">' + reportDate + '</time>' : 'Not listed') + '</dd></div>' +
                    '<div class="lookup-result-fact"><dt>Last checked</dt><dd>' + checked + '</dd></div>' +
                    '</dl>' +
                    '<p class="lookup-result-source"><span class="lookup-result-source-label">Official source</span>' + source + '</p>' +
                    exactSource +
                    lookupFreshnessHTML(office, meta) +
                    '<div class="lookup-result-actions">' +
                    lookupWatchButtonHTML(number, office) +
                    '<button type="button" class="btn lookup-result-btn lookup-result-alert" data-lookup-alert="' +
                    escapeHtml(number) + '" data-lookup-alert-office="' + escapeHtml(office) +
                    '" aria-label="Get decision alerts for application ' + escapeHtml(number) + '">Get decision alerts</button>' +
                    '<button type="button" class="btn secondary lookup-result-btn lookup-result-share" data-lookup-share="' +
                    escapeHtml(number) + '" data-lookup-share-office="' + escapeHtml(office) +
                    '" aria-label="Copy result link for application ' + escapeHtml(number) + '" aria-describedby="' + privacyId +
                    '">Copy result link</button>' +
                    '<div class="lookup-result-status" data-lookup-action-status role="status" aria-live="polite"></div>' +
                    '<p class="lookup-result-privacy" id="' + privacyId + '">A copied link contains application number ' +
                    escapeHtml(number) + '. Share it only with people you trust.</p>' +
                    '</div>' + lookupNextStepsHTML(row) + '</article>';
            }

            function homeLookupReportDatesHTML(metas) {
                var rows = WATCH_OFFICES.map(function(office) {
                    var meta = lookupOfficeMeta(office, metas);
                    var date = lookupFormatDate(meta.report_date);
                    if (!date) return '';
                    var label = escapeHtml(officeName(office));
                    if (meta.source_url) {
                        label = '<a href="' + escapeHtml(meta.source_url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
                    }
                    return '<li>' + label + ': ' + date + '</li>';
                }).filter(Boolean);
                if (!rows.length) return '';
                return '<details class="home-lookup-report-dates"><summary>Latest report dates by office</summary>' +
                    '<ul>' + rows.join('') + '</ul></details>';
            }

            function homeLookupNoResultHTML(term, metas) {
                var scope = homeSearchOffice === 'all'
                    ? 'all six offices'
                    : officeName(homeSearchOffice);
                var number = normalizeIRL(term || homeSearchTerm);
                var selectedOffice = homeSearchOffice === 'all' ? '' : homeSearchOffice;
                var officePicker = '<div class="home-noresult-picker">' +
                    '<label class="home-noresult-label" for="home-noresult-office">Office on your receipt</label>' +
                    '<select id="home-noresult-office" class="home-noresult-select" data-home-noresult-office>' +
                    '<option value=""' + (selectedOffice ? '' : ' selected') + '>Choose an office</option>' +
                    WATCH_OFFICES.map(function(office) {
                        return '<option value="' + office + '"' + (office === selectedOffice ? ' selected' : '') + '>' +
                            escapeHtml(WATCH_OFFICE_NAMES[office]) + '</option>';
                    }).join('') + '</select></div>';
                var notify = number.length >= 4 ?
                    '<div class="home-noresult-notify">' +
                    '<h4>Get notified if this number appears</h4>' +
                    '<p>Choose the office that processed the application. You can save it in this browser or set a Telegram alert.</p>' +
                    '<div class="home-noresult-controls">' + officePicker +
                    '<button type="button" class="btn lookup-result-btn" data-home-noresult-watch="' + escapeHtml(number) +
                    '" aria-pressed="false">Watch this number</button>' +
                    '<button type="button" class="btn lookup-result-btn lookup-result-alert" data-home-noresult-alert="' +
                    escapeHtml(number) + '">Get decision alerts</button>' +
                    '</div><div class="home-noresult-status" data-home-noresult-status role="status" aria-live="polite"></div>' +
                    '</div>' : '';
                return '<div class="home-lookup-empty">' +
                    '<h3>No published decision found</h3>' +
                    '<p>We searched ' + escapeHtml(scope) + ' for <strong>' +
                        escapeHtml(term || homeSearchTerm.trim()) + '</strong>. This is not a refusal: the number is not in the reports we could check.</p>' +
                    '<p class="home-lookup-empty-tip">' + (homeSearchOffice === 'all'
                        ? 'Try another number format, or check that the application is under the office on your receipt. We already searched all six offices.'
                        : 'Try another office in the selector above, or choose <strong>All six offices</strong>.') + '</p>' +
                    notify +
                    '<div class="lookup-steps home-lookup-check-next"><h4>What to check next</h4><ol>' +
                    '<li>Use the application number on your receipt or decision email. Do not use a VFS reference or passport number; an <strong>IRL</strong> prefix, spaces and dashes are optional.</li>' +
                    '<li>' + (homeSearchOffice === 'all'
                        ? 'Check the visa office on your receipt. We already searched all six offices; a decision appears under the office that processed the application.'
                        : 'Check the visa office. Search <strong>all six offices</strong>; a decision appears under the office that processed the application.') + '</li>' +
                    '<li>Allow time for publication. Offices publish on different schedules, so a recent decision may not appear yet. The latest report dates are listed below.</li>' +
                    '<li>If the official report lists this number but this page does not, <a href="/contact#feedback">send a correction</a> with the number, office and report date.</li>' +
                    '</ol>' + homeLookupReportDatesHTML(metas) + '</div>' +
                    '<div class="home-lookup-empty-actions">' +
                    (homeSearchOffice !== 'all' ? '<button type="button" class="btn" data-home-office-all>Search all six offices</button>' : '') +
                    '<button type="button" class="btn" data-home-retry>Try this search again</button>' +
                    '<a class="home-lookup-link" href="/status">See data status</a>' +
                    '</div>' +
                    '<p class="home-lookup-empty-foot">Still stuck? <a href="/contact#feedback">Send a correction or ask a question</a>.</p>' +
                    '</div>';
            }

            function noResultOffice() {
                var select = document.getElementById('home-noresult-office');
                return select && WATCH_OFFICES.indexOf(select.value) !== -1 ? select.value : '';
            }

            function handleNoResultWatch(btn) {
                var number = normalizeIRL(btn.getAttribute('data-home-noresult-watch') || '');
                var status = document.querySelector('[data-home-noresult-status]');
                var office = noResultOffice();
                if (!number) return;
                if (!office) {
                    if (status) { status.textContent = 'Choose the office on your receipt first.'; status.classList.add('is-error'); }
                    return;
                }
                var saved = lookupWatchSaved(number, office);
                if (saved) {
                    var removal = removeWatchItem(number, office);
                    if (!removal.saved) {
                        if (status) { status.textContent = 'Could not remove this application from this browser.'; status.classList.add('is-error'); }
                        return;
                    }
                    if (removal.item) disableWatchPush(removal.item);
                    btn.setAttribute('aria-pressed', 'false');
                    btn.textContent = 'Watch this number';
                    btn.classList.remove('is-saved');
                    if (status) { status.textContent = 'Removed from your watchlist.'; status.classList.remove('is-error'); }
                    return;
                }
                var added = addWatchItem({ number: number, office: office });
                if (added === 'added' || added === 'duplicate') {
                    btn.setAttribute('aria-pressed', 'true');
                    btn.textContent = 'Watching';
                    btn.classList.add('is-saved');
                    if (status) {
                        status.textContent = added === 'duplicate'
                            ? 'Already saved in this browser.'
                            : 'Saved. Open Saved to check it whenever you visit.';
                        status.classList.remove('is-error');
                    }
                    if (added === 'added') trackConversion('watchlist_added', 'lookup_empty');
                } else if (status) {
                    status.textContent = added === 'limit'
                        ? 'Your watchlist is full (10 applications). Remove one before adding another.'
                        : 'Could not save to this browser. Check that storage is allowed and try again.';
                    status.classList.add('is-error');
                }
            }

            function handleNoResultAlert(btn) {
                var number = normalizeIRL(btn.getAttribute('data-home-noresult-alert') || '');
                var status = document.querySelector('[data-home-noresult-status]');
                var office = noResultOffice();
                if (!number) return;
                if (!office) {
                    if (status) { status.textContent = 'Choose the office on your receipt first.'; status.classList.add('is-error'); }
                    return;
                }
                openAlertForResult(number, office);
            }

            function homeLookupErrorHTML() {
                return '<div class="home-lookup-empty">' +
                    '<h3>Search could not be completed</h3>' +
                    '<p>One or more office files could not be loaded. Check your connection and try again.</p>' +
                    '<div class="lookup-steps"><h4>What to check next</h4><ol>' +
                    '<li>Check your internet connection and try the search again.</li>' +
                    '<li>If it still fails, open <a href="/status">Data status</a> to see whether the office reports are available.</li>' +
                    '<li>If the official report lists your number, <a href="/contact#feedback">send a correction</a> with the number, office and report date.</li>' +
                    '</ol></div>' +
                    '<div class="home-lookup-empty-actions"><button type="button" class="btn" data-home-retry>Try again</button>' +
                    '<a class="home-lookup-link" href="/status">See data status</a></div></div>';
            }

            function paintHomeLookup(term, rows, total, metas, fallback) {
                var box = document.getElementById('home-lookup-results');
                var status = document.getElementById('home-lookup-status');
                if (!box) return;
                var fallbackNote = lookupFallbackNoteHTML(fallback);
                if (!rows.length) {
                    if (status) status.textContent = 'No published decision found for ' + (term || homeSearchTerm.trim()) +
                        (fallback ? ' in the fallback index.' : '.');
                    box.innerHTML = fallbackNote + homeLookupNoResultHTML(term, metas);
                    var noResultWatch = box.querySelector('[data-home-noresult-watch]');
                    if (noResultWatch) noResultWatchButtonState(noResultWatch, noResultWatch.getAttribute('data-home-noresult-watch'));
                    return;
                }
                var scope = homeSearchOffice === 'all' ? 'all six offices' : officeName(homeSearchOffice);
                var countText = total + ' published match' + (total === 1 ? '' : 'es') +
                    ' across ' + scope + (rows.length < total ? ' \u00b7 showing first ' + rows.length : '');
                if (status) status.textContent = countText + (fallback ? ' \u00b7 fallback index' : '');
                box.innerHTML = fallbackNote + safetyNoticeHTML() + '<div class="home-lookup-result-list">' +
                    rows.map(function(row) { return lookupResultCardHTML(row, metas); }).join('') + '</div>' +
                    '<p class="home-lookup-foot">Decision and report dates come from the office\'s published report. Always confirm details with the official source and your decision letter.</p>';
            }

            function lookupSetWatchButton(btn, saved) {
                if (!btn) return;
                var number = btn.getAttribute('data-lookup-number') || '';
                btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
                btn.setAttribute('aria-label', saved
                    ? 'Watching application ' + number + '. Remove from your watchlist'
                    : 'Watch this application: ' + number);
                btn.title = saved ? 'Remove from your watchlist' : 'Save to your watchlist';
                btn.classList.toggle('is-saved', saved);
                btn.textContent = saved ? 'Watching' : 'Watch this application';
            }

            function shareLookupResult(btn) {
                var number = btn.getAttribute('data-lookup-share') || '';
                var office = btn.getAttribute('data-lookup-share-office') || '';
                var card = btn.closest('.lookup-result-card');
                var status = card && card.querySelector('[data-lookup-action-status]');
                var url = new URL(location.href);
                url.search = '';
                var params = new URLSearchParams();
                params.set('tracker', 'visa');
                params.set('tab', 'search');
                params.set('q', number);
                if (office) params.set('office', office);
                url.hash = '';
                url.search = params.toString();
                var showCopied = function() {
                    if (status) {
                        status.textContent = 'Link copied. It contains the application number, so share it only with people you trust.';
                        status.classList.remove('is-error');
                    }
                };
                var copyPrompt = 'This link contains the application number. Share it only with people you trust. Copy it here:';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url.href).then(showCopied).catch(function() {
                        window.prompt(copyPrompt, url.href);
                    });
                } else {
                    window.prompt(copyPrompt, url.href);
                }
            }

            function handleLookupWatch(btn) {
                var number = btn.getAttribute('data-lookup-number') || '';
                var office = btn.getAttribute('data-lookup-office') || '';
                var card = btn.closest('.lookup-result-card');
                var status = card && card.querySelector('[data-lookup-action-status]');
                var saved = btn.getAttribute('aria-pressed') === 'true';
                if (!number || WATCH_OFFICES.indexOf(office) === -1) return;

                if (!saved) {
                    var added = addWatchItem({ number: number, office: office });
                    if (added === 'added' || added === 'duplicate') {
                        lookupSetWatchButton(btn, true);
                        if (status) {
                            status.textContent = added === 'duplicate'
                                ? 'Already saved in this browser.'
                                : 'Saved to your watchlist in this browser.';
                            status.classList.remove('is-error');
                        }
                    } else if (status) {
                        status.textContent = added === 'limit'
                            ? 'Your watchlist is full (10 applications). Remove one before adding another.'
                            : 'Could not save to this browser. Check that storage is allowed and try again.';
                        status.classList.add('is-error');
                    }
                    return;
                }

                var removed = removeWatchItem(number, office);
                if (!removed.saved) {
                    if (status) {
                        status.textContent = 'Could not remove this application from this browser. Check that storage is allowed and try again.';
                        status.classList.add('is-error');
                    }
                    return;
                }
                if (removed.item && removed.item.push) disableWatchPush(removed.item);
                lookupSetWatchButton(btn, false);
                if (status) {
                    status.textContent = 'Removed from your watchlist.';
                    status.classList.remove('is-error');
                }
            }

            function runHomeLookup() {
                var box = document.getElementById('home-lookup-results');
                var status = document.getElementById('home-lookup-status');
                if (!box) return;
                var raw = homeSearchTerm.trim();
                var term = normalizeIRL(raw);
                if (!raw) {
                    homeLookupSeq += 1;
                    if (status) status.textContent = 'Choose a number and office. All six offices are searched by default.';
                    box.innerHTML = '';
                    return;
                }
                if (!term) {
                    homeLookupSeq += 1;
                    if (status) status.textContent = 'Enter the digits from the application number.';
                    box.innerHTML = '<div class="home-lookup-empty home-lookup-empty-small"><h3>Start with your application number</h3>' +
                        '<p>Enter the number on your receipt or decision email. Do not use a VFS reference or passport number. An <strong>IRL</strong> prefix, spaces and dashes are optional.</p></div>';
                    return;
                }
                if (term.length < 4) {
                    homeLookupSeq += 1;
                    if (status) status.textContent = 'Keep typing \u2014 enter at least 4 digits to search.';
                    box.innerHTML = '<div class="home-lookup-empty home-lookup-empty-small"><h3>Add a few more digits</h3>' +
                        '<p>Search needs at least 4 digits. Check the application number on your receipt or decision email; an <strong>IRL</strong> prefix, spaces and dashes are optional.</p></div>';
                    return;
                }
                var seq = ++homeLookupSeq;
                var scope = homeSearchOffice === 'all' ? 'all six offices' : officeName(homeSearchOffice);
                if (status) status.textContent = 'Searching ' + scope + '\u2026';
                box.innerHTML = '<div class="home-lookup-loading" role="status">' + searchIcon() +
                    '<span>Searching ' + escapeHtml(scope) + '\u2026</span></div>';
                var filters = homeSearchOffice === 'all' ? {} : { embassy: homeSearchOffice };
                var apiLookup = fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: term,
                        mode: 'fuzzy',
                        filters: filters,
                        limit: 100,
                        sort: 'date_desc'
                    })
                }).then(function(res) {
                    if (!res.ok) throw new Error('Search HTTP ' + res.status);
                    return res.json();
                });
                Promise.all([apiLookup, loadOfficeLookupMeta()]).then(function(outcome) {
                    if (seq !== homeLookupSeq) return;
                    var payload = outcome[0] || {};
                    var manifest = outcome[1] || {};
                    if (!payload.success || !Array.isArray(payload.results)) {
                        throw new Error(payload.error || 'Search failed');
                    }
                    var metas = Object.create(null);
                    Object.keys(manifest).forEach(function(office) {
                        metas[office] = Object.assign({}, manifest[office] || {});
                    });
                    var matches = payload.results.map(prepareLookupRow);
                    var total = payload.pagination && Number(payload.pagination.total) >= 0
                        ? Number(payload.pagination.total)
                        : matches.length;
                    paintHomeLookup(term, matches.slice(0, 100), total, metas);
                }).catch(function(error) {
                    if (seq !== homeLookupSeq) return;
                    console.warn('Live office lookup failed, trying fallback:', error);
                    if (status) status.textContent = 'Live search is unavailable. Checking the fallback index\u2026';
                    offlineLookup(term, homeSearchOffice).then(function(fallback) {
                        if (seq !== homeLookupSeq) return;
                        paintHomeLookup(term, fallback.results, fallback.total, fallback.metas, fallback);
                    }).catch(function(fallbackError) {
                        if (seq !== homeLookupSeq) return;
                        console.warn('Fallback lookup failed:', fallbackError);
                        if (status) status.textContent = 'Search failed. Please try again.';
                        box.innerHTML = homeLookupErrorHTML();
                    });
                });
            }

            // Two-phase render: layout (cards + latest table shell) paints ONCE
            // per tab switch. paintHomeRows() then updates the lower New Delhi
            // table; the all-office lookup repaints independently in the panel
            // above it.
            function renderHomeLayout(rows) {
                const empty = '<div class="empty">No New Delhi decisions recorded yet. The all-office search above still checks the other offices.</div>';
                if (!rows.length) return staleBannerHTML() + homeLookupHTML() + empty;
                const model = getDatasetModel(rows);
                const latest = model.latestDay;
                if (!latest) return staleBannerHTML() + homeLookupHTML() + empty;
                // Newest day with real data (the latest Excel file's date); the
                // top day may instead be a placeholder notice like "no file yet".
                const latestPlaceholder = model.latestPlaceholder;
                const latestDate = model.latestRealDay ? model.latestRealDay[0] : latest[0];
                const latestCount = model.latestCount;

                return staleBannerHTML() +
                    homeLookupHTML() +
                    renderAdvancedSearchPanel() +
                    '<section class="home-freshness" aria-labelledby="home-freshness-title">' +
                    '<div class="home-freshness-head"><div>' +
                    '<h2 class="landing-h3" id="home-freshness-title">Data freshness</h2>' +
                    '<p class="note2">Latest New Delhi file: <strong>' + escapeHtml(humanDate(latestDate)) +
                    '</strong> (' + latestCount.toLocaleString() + ' decisions). Other offices publish on their own schedules.</p>' +
                    '</div><div class="home-freshness-links"><a class="home-freshness-link" href="/status">Data status</a>' +
                    '<a class="home-freshness-link" href="/feed.xml">Official file feed</a></div></div>' +
                    '<div id="meta-box" aria-live="polite"></div>' +
                    '<details class="home-freshness-details"><summary>How to read these dates</summary>' +
                    '<p>Decision date is the date attached to an individual row. Report date is the date of the office file that published it. They can differ, especially for weekly reports.</p>' +
                    '<p>Next expected New Delhi update: weekdays around <strong>' +
                    scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_UPDATE_MINUTE) +
                    '</strong>. The embassy does not publish on weekends or public holidays. ' +
                    '<a href="/api/calendar/offices.ics">Subscribe to expected windows for all six offices</a>.</p>' +
                    '</details></section>' +
                    '<section class="home-latest" aria-labelledby="home-latest-title">' +
                    '<div class="home-latest-head"><div>' +
                    '<h2 class="landing-h3" id="home-latest-title">Latest New Delhi decisions</h2>' +
                    '<p class="note2">Ten most recent rows from the latest file. Search above covers all six offices; full history is under <a href="?tracker=visa&amp;tab=history&amp;view=past">History</a>.</p>' +
                    '</div><details class="download-menu"><summary>Download</summary><div class="download-menu-panel">' +
                    '<button type="button" class="export-btn" id="home-export" title="Download the latest New Delhi decisions as CSV">CSV</button>' +
                    '<button type="button" class="export-btn" id="home-export-excel" title="Download the latest New Delhi decisions as Excel">Excel</button>' +
                    '<button type="button" class="export-btn" id="home-export-pdf" title="Download the latest New Delhi decisions as PDF">PDF</button>' +
                    '</div></details></div>' +
                    publishStatusHTML(rows) +
                    sinceBannerHTML(rows) +
                    (latestPlaceholder ? '<div class="ph-banner">' + placeholderNote(latestPlaceholder.decision) + '</div>' : '') +
                    '<div class="note" id="home-results-count" aria-live="polite" style="margin-bottom:8px;margin-top:0;"></div>' +
                    '<div class="table-wrap"><table class="results-table home-results-table"><thead><tr><th>Date</th><th>Application No.</th><th>Decision</th></tr></thead>' +
                    '<tbody id="home-rows"></tbody></table></div>' +
                    '<p class="home-latest-foot"><a href="?tracker=visa&amp;tab=history&amp;view=past">View all published decisions</a> &middot; <a href="/help#missing">Why a result may be missing</a></p>' +
                    '</section>';
            }

            function paintHomeRows() {
                var tbody = document.getElementById('home-rows');
                if (!tbody) return;
                // Disconnect any prior infinite-scroll observer from a previous filter state.
                if (tbody._sentinelObs) { tbody._sentinelObs.disconnect(); tbody._sentinelObs = null; }
                while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
                var rows = cache || [];
                var model = getDatasetModel(rows);
                var latest = model.latestDay;
                var latestPlaceholder = model.latestPlaceholder;
                var visible = model.latestRealDay ? (model.realByDate.get(model.latestRealDay[0]) || []) : [];
                // Keep the newest file as a compact preview on Search. The full
                // day stays one click away in History, which keeps Search and
                // Saved applications close together on a phone.
                var preview = visible.slice(0, 10);
                var countNote = document.getElementById('home-results-count');
                if (countNote) {
                    if (latestPlaceholder) {
                        countNote.textContent = 'No decisions file published for ' + humanDate(latestPlaceholder.date) + ' yet.';
                    } else if (latest) {
                        var countHtml = 'Latest New Delhi file: ' + escapeHtml(humanDate(latest[0])) + ' (' + visible.length + ' rows)';
                        if (visible.length > preview.length) {
                            countHtml += ' \u00b7 showing ' + preview.length +
                                ' \u00b7 <a href="?tracker=visa&amp;tab=history&amp;view=past&date=' +
                                encodeURIComponent(latest[0]) + '">View all</a>';
                        }
                        countNote.innerHTML = countHtml;
                    } else {
                        countNote.textContent = '';
                    }
                }
                if (latestPlaceholder) {
                    tbody.innerHTML = '<tr class="ph-row"><td class="mono"><time datetime="' + escapeHtml(latestPlaceholder.date) + '">' +
                        escapeHtml(humanDate(latestPlaceholder.date)) + '</time></td><td colspan="2">' + placeholderNote(latestPlaceholder.decision) + '</td></tr>';
                    return;
                }
                renderRowsProgressive(tbody, preview);
            }

            // Community-reported waits panel (item 6). Filled once per layout
            // render (guarded by dataset.done); the JSON is cached after first
            // load so repeat visits cost nothing.
            function communityBoxHTML(stats, tracker) {
                var where = tracker === '1g' ? 'Stamp 1G renewals' : 'embassy visas';
                var link = tracker === '1g'
                    ? '<a href="?tracker=1g">Share your timeline</a>'
                    : '<a href="/contact#share-timeline">Share your timeline</a>';
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
                    tbody.innerHTML = rows.map(rowHTML).join('');
                    return;
                }
                tbody.innerHTML = rows.slice(0, CHUNK).map(rowHTML).join('');
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
                    sentinel.insertAdjacentHTML('beforebegin', next.map(rowHTML).join(''));
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
            function heatmapHTML(byDate, realByDate) {
                const counts = new Map();
                byDate.forEach(([date]) => {
                    counts.set(date, (realByDate.get(date) || []).length);
                });
                const newDelhiToday = newDelhiNow();
                const today = newDelhiToday ? newDelhiToday.date : new Date().toISOString().slice(0, 10);
                const todayDate = new Date(today + 'T00:00:00Z');
                const start = new Date(todayDate);
                start.setUTCDate(start.getUTCDate() - 90);
                start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back to Sunday
                const cells = [];
                const cur = new Date(start);
                while (cur <= todayDate) {
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
                if (!rows.length) return '<div class="empty">No decisions recorded yet.</div>';
                const model = getDatasetModel(rows);
                const byDate = model.byDate;
                const days = byDate.slice(0, dailyVisibleLimit);
                const trs = days.map(([date, dayRows], idx) => {
                    const real = model.realByDate.get(date) || [];
                    if (!real.length) {
                        // Notice day (no file / office closed): show the real
                        // message instead of counting the notice as 1 application.
                        const placeholder = dayRows.find(r => r._placeholder);
                        return '<tr class="ph-row"><td class="mono"><time datetime="' + escapeHtml(date) + '">' +
                            escapeHtml(humanDate(date)) + '</time></td><td colspan="4">' +
                            placeholderNote(placeholder ? placeholder.decision : '') + '</td></tr>';
                    }
                    // Day-on-day compares against the previous day that has REAL
                    // data, so placeholder days don't skew the delta.
                    const prevReal = byDate.slice(idx + 1).find(d => (model.realByDate.get(d[0]) || []).length);
                    const prevCount = prevReal ? model.realByDate.get(prevReal[0]).length : null;
                    const diff = prevCount === null ? null : real.length - prevCount;
                    const acc = (model.acceptedByDate.get(date) || 0) / real.length;
                    const rej = (model.rejectedByDate.get(date) || 0) / real.length;
                    return '<tr><td class="mono dd-toggle" role="button" tabindex="0" aria-expanded="false" title="Show the applications behind this day\u2019s numbers">' +
                        '<span class="dd-caret" aria-hidden="true">\u25b8</span><time datetime="' + escapeHtml(date) + '">' +
                        escapeHtml(humanDate(date)) + '</time></td><td>' + real.length + '</td><td>' +
                        (diff === null ? '-' : ('<span class="pill ' + (diff >= 0 ? 'green' : 'red') + '">' + (
                            diff >= 0 ? '+' : '') + diff + '</span>')) +
                        '</td><td title="Based on ' + real.length + ' published decisions">' + fmtPct(acc) + '</td><td title="Based on ' + real.length + ' published decisions">' + fmtPct(rej) + '</td></tr>' +
                        '<tr class="dd-row"><td colspan="5"><div class="dd-note">These ' + real.length +
                        ' rows were first recorded on ' + escapeHtml(humanDate(date)) + '. The embassy file is sorted by application number, so this is the day the tracker first saw them, not their decision date.</div>' +
                        '<div class="dd-list">' + real.map(function(r) {
                            return '<div class="dd-list-item"><span class="mono">' + escapeHtml(r.irl) +
                                '</span><span class="pill ' + r._pillClass + '">' + escapeHtml(r.decision || '-') + '</span></div>';
                        }).join('') + '</div></td></tr>';
                }).join('');
                return heatmapHTML(byDate, model.realByDate) +
                    '<div class="table-wrap"><table class="daily-table"><thead><tr><th>Date</th><th>Applications Processed</th><th>Day-on-Day</th><th>Accepted Share</th><th>Refused Share</th></tr></thead>' +
                    '<tbody>' + trs + '</tbody></table></div>' +
                    '<p class="note2 rate-sample-note">Accepted and refused shares are calculated from <strong>Applications Processed</strong> in the same row. That count is the sample size; days with few decisions can swing widely.</p>' +
                    (byDate.length > dailyVisibleLimit
                        ? '<div class="show-more-wrap"><button type="button" class="btn secondary" data-daily-show-more>Show older days (' +
                            Math.min(DAILY_PAGE_SIZE, byDate.length - dailyVisibleLimit) + ' of ' + (byDate.length - dailyVisibleLimit) + ')</button></div>'
                        : '');
            }

            // ====== PAST TAB ======
            // Same layout/rows split as Home: renderPastLayout() paints the cards,
            // filter row, empty tbody shell, and scroll-to-top button ONCE per tab
            // switch. paintPastRows() then only updates the tbody + count note
            // when the date filter changes - the datepicker stays alive so no
            // cursor restoration is needed.
            function renderPastLayout(rows) {
                if (!rows.length) return '<div class="empty">No decisions recorded yet.</div>';
                const cacheKey = dataVersion + '|' + pastDateFilter + '|' + pastPageSize + '|' + pastStatusFilter;
                if (pastLayoutCache && pastLayoutCache.key === cacheKey) return pastLayoutCache.html;

                const model = getDatasetModel(rows);
                const total = model.total;
                const accepted = model.accepted;
                const rejected = model.rejected;
                const avg = model.averageDaily;
                const wow = model.wow;
                const last7 = model.last7;
                const last30 = model.last30;
                const acc7 = last7 ? model.last7Accepted / last7 : null;
                const acc30 = last30 ? model.last30Accepted / last30 : null;

                const html = '<div class="cards">' +
                    '<div class="card"><div class="label"><i data-lucide="check-circle"></i>Accepted share</div><div class="value green">' + fmtPct(accepted / total) + '</div><div class="hint">' + sampleSizeText(total) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>7-day accepted share</div><div class="value ' + (acc7 === null ? '' : 'green') + '">' + (acc7 === null ? '-' : fmtPct(acc7)) + '</div><div class="hint">' + sampleSizeText(last7, 'in the last 7 days') + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-days"></i>30-day accepted share</div><div class="value ' + (acc30 === null ? '' : 'green') + '">' + (acc30 === null ? '-' : fmtPct(acc30)) + '</div><div class="hint">' + sampleSizeText(last30, 'in the last 30 days') + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="x-circle"></i>Refused share</div><div class="value red">' + fmtPct(rejected / total) + '</div><div class="hint">' + sampleSizeText(total) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="calendar-check"></i>Avg applications/day</div><div class="value">' + avg.toFixed(1) + '</div></div>' +
                    '<div class="card"><div class="label"><i data-lucide="percent"></i>Week-on-week</div><div class="value ' + (wow === null ? '' : (wow >= 0 ? 'green' : 'red')) + '">' + (wow === null ? '-' : ((wow >= 0 ? '+' : '') + fmtPct(wow))) + '</div></div>' +
                    '</div>' +
                    '<div class="filter-row">' +
                    '<div class="note" style="margin-top:0;">Use <a href="?tracker=visa&amp;tab=search">Search</a> for one application number. This view is the full published history.</div>' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                    '<label class="status-filter">Decision <select id="past-status-filter">' +
                    '<option value="all"' + (pastStatusFilter === 'all' ? ' selected' : '') + '>All</option>' +
                    '<option value="accepted"' + (pastStatusFilter === 'accepted' ? ' selected' : '') + '>Accepted</option>' +
                    '<option value="rejected"' + (pastStatusFilter === 'rejected' ? ' selected' : '') + '>Rejected</option>' +
                    '</select></label>' +
                    '<div class="datefilter' + (pastDateFilter ? ' has-filter' : '') + '"><label class="visually-hidden" for="past-date-filter">Filter by date</label><input type="date" id="past-date-filter" name="date" autocomplete="off" aria-label="Filter by date" value="' + escapeHtml(pastDateFilter) + '">' +
                    '<button type="button" class="clear-btn" id="past-date-clear" aria-label="Clear date filter" title="Clear date filter">\u00d7</button>' +
                    '</div>' +
                    '</div>' +
                    '</div>' +
                    '<div class="table-controls">' +
                    '<div class="note" id="past-results-count" aria-live="polite"></div>' +
                    '<label class="page-size-control">Rows per page <select id="past-page-size">' +
                    [50, 100, 250, 500].map(function(n) { return '<option value="' + n + '"' + (pastPageSize === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
                    '</select></label>' +
                    '<button type="button" class="export-btn" id="past-reset">Reset filters</button>' +
                    '<details class="download-menu"><summary>Download</summary><div class="download-menu-panel">' +
                    '<button type="button" class="export-btn" id="past-export" title="Download the visible rows as CSV">CSV</button>' +
                    '<button type="button" class="export-btn" id="past-export-excel" title="Download the visible rows as Excel">Excel</button>' +
                    '<button type="button" class="export-btn" id="past-export-pdf" title="Download the visible rows as PDF">PDF</button>' +
                    '</div></details>' +
                    '</div>' +
                    '<div class="table-wrap"><table class="results-table past-results-table"><thead><tr><th>Date</th><th>Application No.</th><th>Decision</th></tr></thead>' +
                    '<tbody id="past-rows"></tbody></table></div>' +
                    '<div id="past-show-more" class="show-more-wrap"></div>';
                pastLayoutCache = { key: cacheKey, html: html };
                return html;
            }

            function paintPastRows() {
                var tbody = document.getElementById('past-rows');
                if (!tbody) return;
                if (tbody._sentinelObs) { tbody._sentinelObs.disconnect(); tbody._sentinelObs = null; }
                while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
                var model = getDatasetModel(cache || []);
                var filterKey = dataVersion + '|' + pastDateFilter + '|' + pastStatusFilter;
                var visible;
                if (pastRowsCache && pastRowsCache.key === filterKey) {
                    visible = pastRowsCache.rows;
                } else {
                    visible = pastDateFilter
                        ? model.real.filter(function(r) { return r.date === pastDateFilter; })
                        : model.real;
                    if (pastStatusFilter !== 'all') {
                        visible = visible.filter(function(r) { return r._status === pastStatusFilter; });
                    }
                    pastRowsCache = { key: filterKey, rows: visible };
                }
                var phNote = null;
                if (pastDateFilter && !visible.length) {
                    var dayRows = model.byDateMap.get(pastDateFilter) || [];
                    phNote = dayRows.find(function(r) { return r._placeholder; }) || null;
                }
                var countNote = document.getElementById('past-results-count');
                var shown = visible.slice(0, pastVisibleLimit);
                if (countNote) {
                    countNote.textContent = phNote
                        ? 'No decisions file for ' + humanDate(pastDateFilter)
                        : (visible.length + ' ' + (pastStatusFilter === 'all' ? 'rows' : pastStatusFilter + ' rows') +
                            (pastDateFilter ? ' for ' + humanDate(pastDateFilter) : ' total') +
                            (visible.length > shown.length ? ' \u00b7 showing ' + shown.length : ''));
                }
                var more = document.getElementById('past-show-more');
                if (more) {
                    more.innerHTML = visible.length > shown.length
                        ? '<button type="button" class="btn secondary" id="past-show-more-btn">Show more (' +
                            Math.min(pastPageSize, visible.length - shown.length) + ')</button>'
                        : '';
                }
                if (phNote) {
                    tbody.innerHTML = '<tr class="ph-row"><td class="mono"><time datetime="' + escapeHtml(phNote.date) + '">' +
                        escapeHtml(humanDate(phNote.date)) + '</time></td><td colspan="2">' + placeholderNote(phNote.decision) + '</td></tr>';
                    return;
                }
                renderRowsProgressive(tbody, shown);
            }

            // ====== ALERTS TAB ======
            // Alerts are the first thing in the tab: Telegram opens the bot
            // handoff, browser push uses an application already in the local
            // watchlist. Feedback and timeline sharing live on /contact now.
            // Minimum time the 1G timeline "Submitting…" state stays visible -
            // on a fast connection the fetch can resolve in a few ms, which
            // would flash the success card before the label was ever readable.
            const MIN_SUBMIT_MS = 800;

            function alertsPushListHTML(list) {
                if (!list.length) {
                    return '<p class="note2 alerts-push-empty">No applications saved in this browser yet. ' +
                        '<a href="?tracker=visa&amp;tab=search">Find and save one</a> to enable push.</p>';
                }
                return '<div class="alerts-push-items">' + list.map(function(item) {
                    var office = WATCH_OFFICE_NAMES[item.office] || item.office;
                    var label = item.push ? 'Push on' : 'Enable push';
                    return '<div class="alerts-push-item">' +
                        '<div><strong class="mono">' + escapeHtml(item.number) + '</strong>' +
                        '<span class="note2">' + escapeHtml(office) + '</span></div>' +
                        '<button type="button" class="export-btn tu-btn" data-alerts-push="' +
                        escapeHtml(item.number) + '" data-alerts-push-office="' + escapeHtml(item.office) +
                        '" aria-pressed="' + (item.push ? 'true' : 'false') + '">' + label + '</button>' +
                        '</div>';
                }).join('') + '</div>';
            }

            function paintAlertsPush() {
                var box = document.getElementById('alerts-push-list');
                if (!box) return;
                box.innerHTML = alertsPushListHTML(getWatchlist());
            }

            function renderAlertsLayout() {
                return safetyNoticeHTML() +
                    '<p class="alerts-digest-help" role="note"><strong>Telegram-only digest.</strong> The daily and weekly digest groups applications linked to the Telegram bot. Applications saved only in this browser are never uploaded, so they are not included; use browser push for those. After linking, send ' +
                    '<code>/digest weekly</code> in the bot for one grouped summary, or <code>/digest daily</code> for a ' +
                    'digest only when something changes. Add your preferred hour and IANA timezone, for example ' +
                    '<code>/digest daily 8 Europe/Dublin</code>, then use <code>/digest status</code> or ' +
                    '<code>/digest preview</code>. <code>/immediate 12345678</code> keeps one application immediate.</p>' +
                    '<div class="alerts-grid">' +
                        '<form class="card alerts-card" id="alert-form" name="telegram-alerts" novalidate style="max-width:100%;">' +
                            ALERT_FORM_HTML +
                        '</form>' +
                        '<section class="card alerts-card alerts-push-card" id="alerts-push-card" aria-labelledby="alerts-push-title">' +
                            '<h3 class="readme-title" id="alerts-push-title" style="margin-top:0;">Your alert subscriptions</h3>' +
                            '<p class="note2">Saved applications appear here. Browser push is per application and arrives through this browser. Telegram subscriptions are managed inside the Telegram bot.</p>' +
                            '<div id="alerts-push-list"></div>' +
                            '<div class="note" id="alerts-push-status" role="status" aria-live="polite"></div>' +
                            '<p class="note2" style="margin-bottom:0;"><a href="?tracker=visa&amp;tab=saved">Manage saved applications and backups</a></p>' +
                        '</section>' +
                    '</div>' +
                    '<p class="note2 alerts-help">Need to report a correction, send feedback or share your timeline? Those forms now live on <a href="/contact#feedback">Contact &amp; feedback</a>.</p>';
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

            function renderAnomalyEmptyHTML() {
                return '<div class="anomaly-alerts" role="status">' +
                    '<h3><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 9v4M12 17h.01"/></svg> Unusual patterns (experimental)</h3>' +
                    '<p class="note2">Analyst-style checks on volume and approved share. This is not an official warning and does not describe your application.</p>' +
                    '<p class="note2">No unusual patterns were detected in the last 14 days.</p></div>';
            }

            function renderAnomalyAlerts(model) {
                const anomalies = model.anomalies;
                if (!anomalies.length) return renderAnomalyEmptyHTML();
                
                const recent = anomalies.filter(a => {
                    const d = new Date(a.date + 'T00:00:00');
                    const diff = (Date.now() - d) / 86400000;
                    return diff <= 14; // Last 2 weeks
                });
                
                if (!recent.length) return renderAnomalyEmptyHTML();
                
                let html = '<div class="anomaly-alerts" role="status">';
                html += '<h3><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 9v4M12 17h.01"/></svg> Unusual patterns (experimental)</h3>' +
                    '<p class="note2">Analyst-style checks on volume and approval share. This is not an official warning and does not describe your application.</p>';
                html += '<ul>';
                recent.forEach(a => {
                    const icon = a.type === 'volume_spike' ? 'trending-up' : 'alert-triangle';
                    const color = a.severity === 'high' ? 'var(--red)' : 'var(--amber)';
                    html += '<li style="border-left: 3px solid ' + color + '; padding: 8px 12px; margin: 8px 0; background: var(--surface-raised);">' +
                        '<strong>' + escapeHtml(humanDate(a.date)) + '</strong>: ' +
                        (a.type === 'volume_spike' ? 
                            'Unusual volume spike: ' + a.value + ' decisions (expected ~' + a.expected + ')' :
                            'Approved share shift: ' + a.value + ' (expected ~' + a.expected + ')') +
                        '<span class="badge" style="background:' + color + '; margin-left:8px;">' + a.severity + '</span>' +
                        '</li>';
                });
                html += '</ul></div>';
                return html;
            }

            // ====== DECISION BREAKDOWN BY VISA TYPE ======
            function computeVisaTypes(real) {
                const byType = new Map();
                real.forEach(r => {
                    const type = r._visaType || 'Unknown';
                    if (!byType.has(type)) byType.set(type, { type, total: 0, accepted: 0, rejected: 0, other: 0 });
                    const row = byType.get(type);
                    row.total++;
                    if (r._status === 'accepted') row.accepted++;
                    else if (r._status === 'rejected') row.rejected++;
                    else row.other++;
                });
                return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
            }

            function renderVisaTypeBreakdown(model) {
                const byType = model.visaTypes;
                if (!byType.length) return '';

                let html = '<h3>Decisions by Visa Type</h3>';
                html += '<div class="table-wrap visa-type-breakdown"><table class="results-table"><thead>' +
                    '<tr><th>Visa Type</th><th>Total</th><th>Approved</th><th>Refused</th><th>Other</th><th>Approved Share</th></tr></thead><tbody>';

                byType.forEach(d => {
                    const rate = d.total ? ((d.accepted / d.total) * 100).toFixed(1) : 0;
                    html += '<tr>' +
                        '<td><strong>' + escapeHtml(d.type) + '</strong></td>' +
                        '<td>' + d.total.toLocaleString() + '</td>' +
                        '<td class="green">' + d.accepted.toLocaleString() + '</td>' +
                        '<td class="red">' + d.rejected.toLocaleString() + '</td>' +
                        '<td>' + d.other.toLocaleString() + '</td>' +
                        '<td title="Based on ' + d.total.toLocaleString() + ' published decisions"><strong>' + rate + '%</strong></td>' +
                        '</tr>';
                });

                html += '</tbody></table></div>' +
                    '<p class="note2 rate-sample-note">Approved share uses the <strong>Total</strong> column for each visa type; that total is the sample size. Small groups can swing widely.</p>';
                return html;
            }

            // ====== DECISION TRENDS VISUALIZATION ======
            function computeWeekly(real) {
                const byWeek = new Map();
                real.forEach(r => {
                    if (!r.date) return;
                    const dt = new Date(r.date + 'T00:00:00');
                    const weekStart = new Date(dt);
                    weekStart.setDate(dt.getDate() - dt.getDay()); // Sunday
                    const key = weekStart.toISOString().slice(0, 10);
                    if (!byWeek.has(key)) byWeek.set(key, { accepted: 0, rejected: 0, total: 0 });
                    const week = byWeek.get(key);
                    week.total++;
                    if (r._status === 'accepted') week.accepted++;
                    else if (r._status === 'rejected') week.rejected++;
                });

                const weeks = [...byWeek.keys()].sort().slice(-12); // Last 12 weeks
                return {
                    weeks,
                    byWeek,
                    labels: weeks.map(w => new Date(w + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })),
                    accepted: weeks.map(w => byWeek.get(w).accepted),
                    rejected: weeks.map(w => byWeek.get(w).rejected),
                    rate: weeks.map(w => byWeek.get(w).total
                        ? Number(((byWeek.get(w).accepted / byWeek.get(w).total) * 100).toFixed(1))
                        : 0)
                };
            }

            function renderDecisionTrendsChart(model) {
                if (!model.real.length) return '<p class="note2">No data for trends</p>';
                if (!model.weekly.weeks.length) return '<p class="note2">No data for trends</p>';
                return '<div class="chart-container decision-trends-chart">' +
                    '<div class="decision-trends-head">' +
                    '<h3>Weekly decisions and approved share</h3>' +
                    '<p class="decision-trends-note">Counts and approved share have separate scales. Approved share is approved decisions divided by all published decisions in the week; each point uses that week\'s sample, so small weeks can swing widely.</p>' +
                    '</div>' +
                    '<div class="decision-trends-panel">' +
                    '<div class="decision-trends-panel-title"><span>Decisions per week</span><span>applications</span></div>' +
                    '<canvas id="trends-count-chart" class="decision-trends-count-canvas" role="img" aria-label="Weekly approved and refused decisions"></canvas>' +
                    '</div>' +
                    '<div class="decision-trends-panel">' +
                    '<div class="decision-trends-panel-title"><span>Approved share</span><span>percent</span></div>' +
                    '<canvas id="trends-rate-chart" class="decision-trends-rate-canvas" role="img" aria-label="Weekly approved share of published decisions"></canvas>' +
                    '</div>' +
                    '</div>';
            }

            // ====== ANALYTICS TAB ======
            function buildAnalyticsModel(rows, version) {
                const dataset = getDatasetModel(rows);
                const real = dataset.real;
                return {
                    version,
                    rows,
                    real,
                    visaTypes: computeVisaTypes(real),
                    weekly: computeWeekly(real),
                    anomalies: detectAnomalies(real),
                    monthly: computeMonthly(real),
                    rolling30: computeRolling30(real),
                    dailyDelta: computeDailyDelta(real),
                    queueDensity: computeQueueDensity(real)
                };
            }

            function getAnalyticsModel(rows) {
                if (analyticsModel && analyticsModel.version === dataVersion && analyticsModel.rows === rows) {
                    return analyticsModel;
                }
                analyticsModel = buildAnalyticsModel(rows, dataVersion);
                return analyticsModel;
            }

            function scheduleAnalyticsModel() {
                if (!cache || !cache.length) return;
                const version = dataVersion;
                if ((analyticsModel && analyticsModel.version === version) ||
                    analyticsBuildScheduledVersion === version) return;
                analyticsBuildScheduledVersion = version;
                const build = function() {
                    if (version !== dataVersion) return;
                    analyticsBuildScheduledVersion = 0;
                    getAnalyticsModel(cache);
                };
                if (window.requestIdleCallback) window.requestIdleCallback(build, { timeout: 1200 });
                else setTimeout(build, 200);
            }

            function renderAnalyticsLayout(rows) {
                if (!rows.length) return '<div class="empty">No decisions recorded yet.</div>';
                const model = getAnalyticsModel(rows);

                return renderVisaTypeBreakdown(model) +
                    renderDecisionTrendsChart(model) +
                    renderAnomalyAlerts(model) +
                    '<div class="analytics-grid">' +
                        '<div class="chart-container">' +
                            '<h3>Month-by-Month Approved Share</h3>' +
                            '<canvas id="chart-monthly" aria-label="Monthly approved share of published decisions chart"></canvas>' +
                            '<p class="note2 rate-sample-note">Monthly approved shares use that month\'s approved and total published decision counts. Hover a month for the sample size.</p>' +
                        '</div>' +
                        '<div class="chart-container">' +
                            '<h3>30-Day Rolling Approved Share</h3>' +
                            '<canvas id="chart-rolling30" aria-label="30-day rolling approved share of published decisions chart"></canvas>' +
                            '<p class="note2 rate-sample-note">Each point uses decisions from the trailing 30 days; hover for the sample size.</p>' +
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

            function destroyAnalyticsCharts() {
                analyticsChartObservers.forEach(function(observer) { observer.disconnect(); });
                analyticsChartObservers = [];
                analyticsChartInstances.forEach(function(chart) {
                    try { chart.destroy(); } catch (error) { /* already detached */ }
                });
                analyticsChartInstances = [];
                document.querySelectorAll('#tab-body canvas').forEach(function(canvas) {
                    canvas._chart = null;
                });
            }

            function registerAnalyticsChart(canvas, config) {
                if (!canvas || canvas._chart) return canvas && canvas._chart;
                var chart = new Chart(canvas, config);
                canvas._chart = chart;
                analyticsChartInstances.push(chart);
                return chart;
            }

            function drawChartWhenNear(canvas, draw) {
                if (!canvas || canvas._chart) return;
                if (!('IntersectionObserver' in window)) {
                    draw(canvas);
                    return;
                }
                var observer = new IntersectionObserver(function(entries) {
                    if (!entries[0] || !entries[0].isIntersecting) return;
                    observer.disconnect();
                    analyticsChartObservers = analyticsChartObservers.filter(function(item) { return item !== observer; });
                    if (canvas.isConnected && activeTab === 'analytics') draw(canvas);
                }, { rootMargin: '300px' });
                analyticsChartObservers.push(observer);
                observer.observe(canvas);
            }

            function paintAnalyticsCharts() {
                var rows = cache || [];
                if (!rows.length) return;
                var model = getAnalyticsModel(rows);

                // Render the tab shell immediately; Chart.js and chart creation
                // happen after the next frame, and each canvas initialises only
                // when it approaches the viewport.
                LazyLoader.chart().then(function() {
                    requestAnimationFrame(function() {
                        if (activeTab === 'analytics') drawCharts(model);
                    });
                }).catch(function(err) {
                    console.error('Failed to load Chart.js:', err);
                });
            }
            
            function drawCharts(model) {
                var monthly = model.monthly;
                var rolling30 = model.rolling30;
                var dailyDelta = model.dailyDelta;
                var queueDensity = model.queueDensity;
                var ctx;
                
                // Monthly chart (bar + line)
                ctx = document.getElementById('chart-monthly');
                if (ctx) {
                    drawChartWhenNear(ctx, function(canvas) { registerAnalyticsChart(canvas, {
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
                                label: 'Approved Share (%)',
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
                            plugins: {
                                legend: { display: true, position: 'top' },
                                tooltip: { callbacks: { afterBody: function(items) {
                                    var point = items && items.length ? monthly[items[0].dataIndex] : null;
                                    return point ? 'Approved share: ' + point.rate + '% of ' + point.total.toLocaleString() + ' published decisions' : '';
                                } } }
                            }
                        }
                    }); });
                }
                
                // Rolling 30-day chart
                ctx = document.getElementById('chart-rolling30');
                if (ctx) {
                    drawChartWhenNear(ctx, function(canvas) { registerAnalyticsChart(canvas, {
                        type: 'line',
                        data: {
                            labels: rolling30.map(r => r.date),
                            datasets: [{
                                label: '30-Day Rolling Approved Share (%)',
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
                                y: { min: 0, max: 100, title: { display: true, text: 'Approved Share (%)' } },
                                x: { ticks: { maxTicksLimit: 10 } }
                            },
                            plugins: {
                                legend: { display: false },
                                tooltip: { callbacks: { label: function(ctx) {
                                    var point = rolling30[ctx.dataIndex];
                                    return ['Approved share: ' + ctx.parsed.y + '%', 'Sample: ' + (point ? point.total.toLocaleString() : '0') + ' published decisions in 30 days'];
                                } } }
                            }
                        }
                    }); });
                }
                
                // Daily delta chart
                ctx = document.getElementById('chart-daily-delta');
                if (ctx) {
                    drawChartWhenNear(ctx, function(canvas) { registerAnalyticsChart(canvas, {
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
                    }); });
                }
                
                // Queue density chart
                ctx = document.getElementById('chart-queue-density');
                if (ctx) {
                    drawChartWhenNear(ctx, function(canvas) { registerAnalyticsChart(canvas, {
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
                    }); });
                }

                var weekly = model.weekly;
                var countCanvas = document.getElementById('trends-count-chart');
                if (countCanvas) {
                    drawChartWhenNear(countCanvas, function(canvas) {
                        registerAnalyticsChart(canvas, {
                            type: 'bar',
                            data: {
                                labels: weekly.labels,
                                datasets: [
                                    { label: 'Approved', data: weekly.accepted, backgroundColor: '#059669', borderColor: '#047857', borderWidth: 0, borderRadius: 3, maxBarThickness: 28 },
                                    { label: 'Refused', data: weekly.rejected, backgroundColor: '#dc2626', borderColor: '#b91c1c', borderWidth: 0, borderRadius: 3, maxBarThickness: 28 }
                                ]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                interaction: { mode: 'index', intersect: false },
                                scales: {
                                    y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Applications' }, grid: { color: 'rgba(148,163,184,0.18)' } },
                                    x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } }
                                },
                                plugins: {
                                    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 14 } },
                                    tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' decisions'; } } }
                                }
                            }
                        });
                    });
                }

                var rateCanvas = document.getElementById('trends-rate-chart');
                if (rateCanvas) {
                    drawChartWhenNear(rateCanvas, function(canvas) {
                        registerAnalyticsChart(canvas, {
                            type: 'line',
                            data: {
                                labels: weekly.labels,
                                datasets: [{
                                    label: 'Approved share',
                                    data: weekly.rate,
                                    borderColor: '#2563eb',
                                    backgroundColor: 'rgba(37,99,235,0.08)',
                                    borderWidth: 2,
                                    fill: false,
                                    tension: 0,
                                    pointRadius: 3,
                                    pointHoverRadius: 5,
                                    pointBackgroundColor: '#ffffff',
                                    pointBorderColor: '#2563eb',
                                    pointBorderWidth: 2
                                }]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                interaction: { mode: 'index', intersect: false },
                                scales: {
                                    y: { min: 0, max: 100, ticks: { stepSize: 25, callback: function(v) { return v + '%'; } }, title: { display: true, text: 'Approved share' }, grid: { color: 'rgba(148,163,184,0.18)' } },
                                    x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } }
                                },
                                plugins: {
                                    legend: { display: false },
                                    tooltip: { callbacks: { label: function(ctx) {
                                        var week = weekly.weeks[ctx.dataIndex];
                                        var total = week && weekly.byWeek.has(week) ? weekly.byWeek.get(week).total : 0;
                                        return 'Approved share: ' + ctx.parsed.y + '% of ' + total.toLocaleString() + ' published decisions';
                                    } } }
                                }
                            }
                        });
                    });
                }
            }
            
            // Analytics computation functions
            function computeMonthly(rows) {
                var byMonth = {};
                rows.forEach(function(r) {
                    if (r._placeholder || !r.date) return;
                    var month = String(r.date).slice(0, 7);
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
                var total = 0;
                var approved = 0;
                for (var i = 0; i < dates.length; i++) {
                    total += byDate[dates[i]].total;
                    approved += byDate[dates[i]].approved;
                    if (i >= 30) {
                        total -= byDate[dates[i - 30]].total;
                        approved -= byDate[dates[i - 30]].approved;
                    }
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
                var nums = real.map(function(r) { return parseInt(r.number || r.irl, 10); }).filter(function(n) { return Number.isFinite(n); }).sort(function(a, b) { return a - b; });
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

            // 1G timeline submissions (item 6): applied -> decided dates,
            // synced nightly into data/community_timelines.json. The embassy
            // visa form now lives on /contact#share-timeline.
            const TIMELINES_1G_FORM_HTML =
                '<input type="hidden" name="form-name" value="timelines-1g" />' +
                '<h3 class="readme-title" style="margin-top:0;">Share your 1G timeline</h3>' +
                '<p class="note2">Stamp 1G renewals only - when did you apply, and when was it decided? Published anonymously in aggregate.</p>' +
                '<input type="hidden" name="tracker" value="1g" />' +
                '<p><label>Applied on <input type="date" id="time-applied-1g" name="applied" /></label></p>' +
                '<p><label>Decided on <input type="date" id="time-decided-1g" name="decided" /></label></p>' +
                '<p><label>Outcome <select id="time-outcome-1g" name="outcome" aria-label="Outcome" data-glide data-glide-size="sm" data-glide-menu-width="150"><option value="granted">Granted</option><option value="refused">Refused</option></select></label></p>' +
                '<button class="btn" type="submit" id="time-submit-1g">Share Timeline</button>' +
                '<div class="note" id="time-status-1g" aria-live="polite"></div>';

            const ALERT_FORM_HTML =
                '<h3 class="readme-title" style="margin-top:0;">Get Decision Alerts on Telegram</h3>' +
                '<p class="note2">Enter your application number and visa office. We will message you on Telegram when a decision is published. No email address is collected.</p>' +
                '<p><label>Application Number <input type="text" name="application_number" required placeholder="12345678" pattern="\\d{8}" /></label></p>' +
                '<p><label>Visa Office <select name="embassy" required>' +
                    '<option value="new-delhi">🇮🇳 New Delhi (India, Bangladesh, Nepal, Sri Lanka)</option>' +
                    '<option value="beijing">🇨🇳 Beijing (China, Hong Kong, Macau, Mongolia)</option>' +
                    '<option value="dublin">🇮🇪 Dublin (Pakistan + transfers)</option>' +
                    '<option value="abu-dhabi">🇦🇪 Abu Dhabi (UAE, Qatar, Gulf, North Africa)</option>' +
                    '<option value="abuja">🇳🇬 Abuja (Nigeria, Ghana, Côte d\'Ivoire, Senegal)</option>' +
                    '<option value="ankara">🇹🇷 Ankara (Türkiye, Azerbaijan, Saudi Arabia residents)</option>' +
                '</select></label></p>' +
                '<button class="btn" type="submit" id="telegram-alert-btn" style="background:#229ED9;border-color:#229ED9;color:#fff;">Get alerts on Telegram</button>' +
                '<p class="note2" style="margin-top:6px;">Free and no email needed. Opens the Telegram bot with your application ready to link.</p>' +
                '<div class="note" id="alert-status" aria-live="polite"></div>';

            async function submitTimeline() {
                // The embassy-visa timeline form now lives on /contact. This
                // function remains for the separate Stamp 1G form.
                const appliedEl = document.getElementById('time-applied-1g');
                const decidedEl = document.getElementById('time-decided-1g');
                const outcomeEl = document.getElementById('time-outcome-1g');
                const status = document.getElementById('time-status-1g');
                const btn = document.getElementById('time-submit-1g');
                const formId = 'time-form-1g';
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
                        'form-name': 'timelines-1g',
                        'bot-field': '',
                        tracker: '1g',
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
                        '<button class="btn" type="button" id="time-again-1g">Share another</button></div>';
                    const again = document.getElementById('time-again-1g');
                    if (again) again.addEventListener('click', function() {
                        const f = document.getElementById(formId);
                        if (!f) return;
                        f.innerHTML = TIMELINES_1G_FORM_HTML;
                        f.addEventListener('submit', function(e) { e.preventDefault(); submitTimeline(); });
                    });
                } catch (err) {
                    status.textContent = 'Could not submit. Try again.';
                } finally {
                    btn.disabled = false;
                }
            }

            async function startTelegramAlerts() {
                const form = document.getElementById('alert-form');
                const statusEl = document.getElementById('alert-status');
                const btn = document.getElementById('telegram-alert-btn');
                if (!form || !statusEl || !btn) return;
                const appNumEl = form.querySelector('input[name="application_number"]');
                const embassyEl = form.querySelector('select[name="embassy"]');
                const applicationNumber = (appNumEl && appNumEl.value ? appNumEl.value : '').trim();
                const embassy = embassyEl && embassyEl.value ? embassyEl.value : '';

                if (!/^\d{8}$/.test(applicationNumber)) {
                    statusEl.textContent = 'Please enter a valid 8-digit application number.';
                    statusEl.style.color = 'var(--red)';
                    if (appNumEl) appNumEl.focus();
                    return;
                }

                btn.disabled = true;
                statusEl.textContent = 'Opening Telegram…';
                statusEl.style.color = 'var(--ink)';

                try {
                    const res = await fetch('/api/telegram/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ application_number: applicationNumber, embassy: embassy })
                    });
                    const data = await res.json().catch(function() { return {}; });
                    if (res.ok && data.url) {
                        window.open(data.url, '_blank', 'noopener');
                        trackConversion('alert_telegram_opened', 'alerts');
                        statusEl.textContent = 'Press Start in Telegram to finish linking ' + applicationNumber + '.';
                        statusEl.style.color = 'var(--green)';
                    } else {
                        statusEl.textContent = '❌ ' + (data.error || 'Telegram alerts are not available yet.');
                        statusEl.style.color = 'var(--red)';
                    }
                } catch (err) {
                    statusEl.textContent = '❌ Network error. Please try again.';
                    statusEl.style.color = 'var(--red)';
                } finally {
                    btn.disabled = false;
                }
            }


            // Keep the browser chrome in sync with the theme: native controls
            // (date picker, inputs, scrollbars) and the browser UI color.
            function applyChrome() {
                document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
                // The shared Preferences menu toggles the theme, but the sitebar
                // and footer sit outside #visa-dash. Mirror the choice on the
                // document so those shared surfaces follow it too.
                document.documentElement.setAttribute('data-theme', theme);
                const meta = document.querySelector('meta[name="theme-color"]');
                if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#ffffff');
            }

            // ===== tracker landing + Stamp 1G =====
            // Top-level view switcher. 'home' is the landing screen with two
            // tracker cards; 'visa' is the existing embassy-decisions tracker
            // (untouched below); '1g' is the Stamp 1G processing-date tracker
            // fed by data/stamp_1g.json (written daily by track_1g.py).
            const BACK_BTN_HTML = '<button type="button" class="back-btn" id="back-btn">← All trackers</button>';

            function setTracker(id, opts) {
                activeTracker = id;
                if (!(opts && opts.noUrl)) syncUrl('push');
                render();
            }

            function wireChrome() {
                const backBtn = document.getElementById('back-btn');
                if (backBtn) backBtn.addEventListener('click', function() { setTracker('home'); });
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

            // ---- watched applications (local only) ----
            // Stored in this browser; nothing here is tied to an account.
            function normalizeWatchItem(value) {
                var number = '';
                var office = 'new-delhi';
                var nickname = '';
                var push = false;
                var explicitOffice = false;
                if (typeof value === 'string') {
                    number = normalizeIRL(value);
                } else if (value && typeof value === 'object') {
                    number = normalizeIRL(value.number || value.application_number || '');
                    explicitOffice = Boolean(value.office || value.embassy_slug);
                    office = String(value.office || value.embassy_slug || 'new-delhi').trim().toLowerCase();
                    nickname = String(value.nickname || '').slice(0, 60);
                    push = value.push === true;
                }
                if (!number) return null;
                if (WATCH_OFFICES.indexOf(office) === -1) {
                    if (explicitOffice) return null;
                    office = 'new-delhi';
                }
                return { number: number, office: office, nickname: nickname, push: push };
            }
            function cleanWatchlist(values) {
                var seen = {};
                var clean = [];
                (values || []).forEach(function(value) {
                    var item = normalizeWatchItem(value);
                    if (!item) return;
                    var key = item.office + '|' + item.number;
                    if (seen[key]) return;
                    seen[key] = 1;
                    clean.push(item);
                });
                return clean.slice(0, WATCH_LIMIT);
            }
            function getWatchlist() {
                try {
                    var raw = JSON.parse(localStorage.getItem('visa-watchlist') || '[]');
                    return Array.isArray(raw) ? cleanWatchlist(raw) : [];
                } catch (e) { return []; }
            }
            function getWatchSeen() {
                try {
                    var raw = JSON.parse(localStorage.getItem(WATCH_SEEN_KEY) || '{}');
                    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
                } catch (e) { return {}; }
            }
            function saveWatchSeen(map) {
                try {
                    localStorage.setItem(WATCH_SEEN_KEY, JSON.stringify(map || {}));
                } catch (e) {
                    // The saved list itself still works if this optional history
                    // cannot be stored (private mode or full storage).
                }
            }
            function pruneWatchSeen(list) {
                var allowed = Object.create(null);
                (list || []).forEach(function(item) {
                    allowed[item.office + '|' + item.number] = true;
                });
                var seen = getWatchSeen();
                var changed = false;
                Object.keys(seen).forEach(function(key) {
                    if (!allowed[key]) { delete seen[key]; changed = true; }
                });
                if (changed) saveWatchSeen(seen);
            }
            function saveWatchlist(list) {
                try {
                    var clean = cleanWatchlist(list);
                    localStorage.setItem('visa-watchlist', JSON.stringify(clean));
                    pruneWatchSeen(clean);
                    return true;
                } catch (e) {
                    console.warn('watchlist storage failed:', e);
                    return false;
                }
            }
            function watchSeenKey(item) {
                return item.office + '|' + item.number;
            }
            function watchSeenSignature(row, office) {
                return [office || row.embassy || 'new-delhi', row.decision || '', row.date || ''].join('|');
            }
            function watchChangeFor(item, row, seen) {
                var key = watchSeenKey(item);
                var previous = seen[key];
                if (!previous || previous.signature === watchSeenSignature(row, item.office)) return null;
                if (!watchVisitChanges[key]) {
                    watchVisitChanges[key] = {
                        previous: previous,
                        current: {
                            decision: row.decision || '',
                            date: row.date || ''
                        }
                    };
                }
                return watchVisitChanges[key];
            }
            function rememberWatchSeen(item, row, seen) {
                seen[watchSeenKey(item)] = {
                    signature: watchSeenSignature(row, item.office),
                    decision: row.decision || '',
                    date: row.date || '',
                    seen_at: new Date().toISOString()
                };
            }
            function addWatchItem(value) {
                var item = normalizeWatchItem(value);
                if (!item) return 'invalid';
                var list = getWatchlist();
                if (list.some(function(saved) {
                    return saved.number === item.number && saved.office === item.office;
                })) return 'duplicate';
                if (list.length >= WATCH_LIMIT) return 'limit';
                list.unshift(item);
                return saveWatchlist(list) ? 'added' : 'save-failed';
            }
            function removeWatchItem(number, office) {
                var target = normalizeWatchItem({ number: number, office: office });
                if (!target) return { item: null, saved: true };
                var removed = null;
                var next = getWatchlist().filter(function(item) {
                    if (item.number === target.number && item.office === target.office) {
                        removed = item;
                        return false;
                    }
                    return true;
                });
                if (!removed) return { item: null, saved: true };
                return { item: removed, saved: saveWatchlist(next) };
            }
            function updateWatchItemPush(number, office, enabled) {
                var found = false;
                var list = getWatchlist();
                list.forEach(function(item) {
                    if (item.number === number && item.office === office) {
                        item.push = !!enabled;
                        found = true;
                    }
                });
                return found && saveWatchlist(list);
            }
            function disableWatchPush(item) {
                if (!item || typeof window.disablePushNotifications !== 'function') return;
                window.disablePushNotifications(item.number, item.office).then(function(result) {
                    if (result.ok) return;
                    var status = document.getElementById('watch-local-status');
                    if (status) status.textContent = 'Removed locally; browser alerts could not be updated.';
                }).catch(function() { /* local removal already succeeded */ });
            }
            function migrateWatchlist() {
                try {
                    var raw = JSON.parse(localStorage.getItem('visa-watchlist') || '[]');
                    if (!Array.isArray(raw) || !raw.some(function(value) { return typeof value === 'string'; })) return;
                    saveWatchlist(raw);
                } catch (e) { /* corrupt storage is ignored until the next write */ }
            }
            // Rows from visa_decisions.json are the New Delhi tracker and omit
            // `embassy`; a missing office means New Delhi, never a wildcard.
            function watchRowMatches(row, item) {
                return !!row && !!item && !row._placeholder &&
                    normalizeIRL(row.irl) === item.number &&
                    (row.embassy || 'new-delhi') === item.office;
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
                var input = document.getElementById('g1-buffer-input');
                if (!input) return;
                input.value = String(g1StoredBuffer());
                if (input.dataset.wired === '1') return;
                input.dataset.wired = '1';
                input.addEventListener('change', function () {
                    var n = parseInt(input.value, 10);
                    n = isFinite(n) ? Math.max(0, Math.min(12, n)) : 0;
                    input.value = String(n);
                    try { localStorage.setItem('stamp1g-buffer', String(n)); } catch (e) { /* private mode */ }
                    paintG1Estimate();
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
                    '<div class="page-title-block">' +
                    '<h1>Stamp ' + escapeHtml(activeCat) + ' processing</h1>' +
                    '<p class="page-task">The application date ISD is processing, the current lag, and a date estimate.</p>' +
                    '<p class="page-meta">' + (rows.length ? rows.length + ' observation' + (rows.length === 1 ? '' : 's') + ' on record' : 'Awaiting data') + '</p>' +
                    '</div>';
                if (!rows.length) {
                    return head +
                        '<div class="empty">No observations recorded yet. The daily job writes to <code>data/stamp_1g.json</code> - check back after its first run.</div>';
                }
                var catPills = cats.length > 1
                    ? '<div class="category-tabs" id="g1-cats" role="group" aria-label="Stamp category">' +
                      cats.map(function(c) {
                          return '<button type="button" class="recent-chip mode-chip' + (c === activeCat ? ' active' : '') +
                              '" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (c === activeCat) + '">' + escapeHtml(c) + '</button>';
                      }).join('') + '</div>'
                    : '';
                var proj = computeG1Projections(rows);
                var latest = rows[rows.length - 1];
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
                    '<span class="g1-mode segmented">' +
                    '<button type="button" class="recent-chip mode-chip' + (storedMode === 'applied' ? ' active' : '') + '" data-mode="applied" aria-pressed="' + (storedMode === 'applied') + '">I applied</button>' +
                    '<button type="button" class="recent-chip mode-chip' + (storedMode === 'plan' ? ' active' : '') + '" data-mode="plan" aria-pressed="' + (storedMode === 'plan') + '">I plan to apply</button>' +
                    '</span>' +
                    '<div class="datefilter"><label class="visually-hidden" for="g1-apply-date">Application date</label>' +
                    '<input type="date" id="g1-apply-date" autocomplete="off" aria-label="Your application date" value="' + escapeHtml(storedDate) + '">' +
                    '<button type="button" class="clear-btn" id="g1-apply-clear" aria-label="Clear application date" title="Clear application date">\u00d7</button>' +
                    '</div></div>' +
                    '<div class="g1-buffer"><label class="note2" for="g1-buffer-input">Buffer</label>' +
                    '<input type="number" id="g1-buffer-input" min="0" max="12" step="1" value="' + g1StoredBuffer() + '" inputmode="numeric" aria-label="Buffer in weeks">' +
                    '<span class="note2">weeks on top of the current lag</span></div>' +
                    '<div id="g1-estimate" aria-live="polite"></div>' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
                    '<label for="g1-expiry-date" style="font-size:12px;color:var(--ink-muted);">IRP expiry (optional)</label>' +
                    '<div class="datefilter"><label class="visually-hidden" for="g1-expiry-date">IRP expiry date</label>' +
                    '<input type="date" id="g1-expiry-date" autocomplete="off" aria-label="Your IRP expiry date" value="' + escapeHtml(storedExpiry) + '">' +
                    '<button type="button" class="clear-btn" id="g1-expiry-clear" aria-label="Clear expiry date" title="Clear expiry date">\u00d7</button>' +
                    '</div></div>' +
                    '<div id="g1-expiry" aria-live="polite"></div></div>' +
                    '<div id="g1-timeline-form" style="margin-top:24px;"></div>';
                return head + catPills + cards + estimatorHtml + projHtml + chart + hist + '<div id="community-box"></div>' + note;
            }

            async function renderG1Page() {
                document.title = 'Stamp 1G Processing Tracker | Irish Visa Decision Tracker';
                if (!g1Cache) {
                    root.innerHTML = BACK_BTN_HTML +
                        '<div class="page-title-block">' +
                        '<h1>Stamp 1G processing</h1>' +
                        '<p class="page-task">The application date ISD is processing, the current lag, and a date estimate.</p>' +
                        '<p class="page-meta">Loading the current observations…</p>' +
                        '</div>' +
                        '<div class="skel-wrap">' +
                        '<div class="skel skel-row" style="width:65%"></div>' +
                        '<div class="skel skel-row" style="width:45%"></div>' +
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
                        submitTimeline();
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
                    '<div class="page-title-block">' +
                    '<h1>Employment permit processing</h1>' +
                    '<p class="page-task">The processing date and current lag for each DETE permit category.</p>' +
                    '<p class="page-meta">' + (rows.length ? rows.length + ' observation' + (rows.length === 1 ? '' : 's') + ' on record' : 'Awaiting data') + '</p>' +
                    '</div>';
                if (!rows.length) {
                    return head +
                        '<div class="empty">No observations recorded yet. The daily job writes to <code>data/work_permits.json</code> - check back after its first run.</div>';
                }
                var catPills = cats.length > 1
                    ? '<div class="category-tabs" id="permits-cats" role="group" aria-label="Permit category">' +
                      cats.map(function(c) {
                          return '<button type="button" class="recent-chip mode-chip' + (c === activeCat ? ' active' : '') +
                              '" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (c === activeCat) + '">' + escapeHtml(c) + '</button>';
                      }).join('') + '</div>'
                    : '';
                var proj = computeG1Projections(rows);
                var latest = rows[rows.length - 1];
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
                return head + catPills + cards + hist + note;
            }

            async function renderPermitsPage() {
                document.title = 'Employment Permit Tracker | Irish Visa Decision Tracker';
                if (!permitsCache) {
                    root.innerHTML = BACK_BTN_HTML +
                        '<div class="page-title-block">' +
                        '<h1>Employment permit processing</h1>' +
                        '<p class="page-task">The processing date and current lag for each DETE permit category.</p>' +
                        '<p class="page-meta">Loading the current observations…</p>' +
                        '</div>' +
                        '<div class="skel-wrap">' +
                        '<div class="skel skel-row" style="width:65%"></div>' +
                        '<div class="skel skel-row" style="width:45%"></div>' +
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
                return '<button type="button" class="tracker-card tracker-row' + (accent ? ' ' + accent : '') + '" data-tracker="' + id + '">' +
                    '<span class="tracker-row-copy"><span class="tracker-title">' + title + '</span>' +
                    '<span class="tracker-desc">' + desc + '</span></span>' +
                    '<span class="tracker-row-meta"><span class="tracker-meta" id="' + metaId + '" aria-live="polite">' + meta + '</span>' +
                    '<span class="tracker-cta">Open →</span></span></button>';
            }

            // Landing status strip: one glanceable line built from the tiny
            // meta file + 1G history (never the full visa payload). Pure
            // function of its inputs so it can be unit-tested; numbers only,
            // no user-controlled strings - no escaping needed.
            function landingStatusHTML(meta, g1Rows, todayNewDelhi) {
                var parts = [];
                // Ticker tracks the headline 1G series even once other stamp
                // categories share the file.
                g1Rows = g1RowsFor(g1Rows, '1G');
                var wd = new Date(todayNewDelhi + 'T00:00:00').getDay();
                if (wd === 0 || wd === 6) {
                    parts.push('Embassy closed today - back Monday');
                } else if (meta && meta.lastRunAt) {
                    if (String(meta.lastRunAt).slice(0, 10) === todayNewDelhi) {
                        parts.push('Today\u2019s embassy file is in' +
                            (meta.newRows ? ' \u00b7 <strong>' + meta.newRows + ' new decisions</strong>' : ''));
                    } else {
                        parts.push('Today\u2019s embassy file not yet published (expected ~' +
                            scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_UPDATE_MINUTE) + ')');
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
                try { renderRecentDecisionsFeed(); } catch (e) { console.warn('recent:', e); }
                try { setupPWAInstallButton(); } catch (e) { console.warn('pwa:', e); }
                try { initCalendarComponents(); } catch (e) { console.warn('calendar:', e); }

                // The stats/recent sections need the visa history.
                // Fetch it in the background after first paint so the landing
                // page stays instant, then repaint just those sections.
                if (!_landingDataRequested && (!cache || !cache.length)) {
                    _landingDataRequested = true;
                    loadData().then(function() {
                        if (activeTracker !== 'home') return;
                        try { updateLandingStats(); } catch (e) { /* noop */ }
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
                var approvalSampleEl = document.getElementById('stat-approval-sample');
                var updatedEl = document.getElementById('stat-updated');

                if (decisionsEl) {
                    decisionsEl.textContent = real.length ? real.length.toLocaleString() : '\u2014';
                }
                if (approvalEl) approvalEl.textContent = rate;
                if (approvalSampleEl) {
                    approvalSampleEl.textContent = real.length
                        ? 'of ' + real.length.toLocaleString() + ' decisions'
                        : 'No decisions yet';
                }
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
                        updatedEl.innerHTML = newDelhiTimeNode(meta.lastRunAt, 'full');
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

                container.innerHTML =
                    '<div class="table-wrap coverage-table-wrap" role="region" aria-label="Office coverage table" tabindex="0">' +
                    '<table class="coverage-table">' +
                    '<caption>Latest official publication from each office, with a link to the source.</caption>' +
                    '<thead><tr><th scope="col">Office</th><th scope="col">Latest report</th><th scope="col" class="num">Decisions</th><th scope="col">Source</th><th scope="col">Fetched</th></tr></thead>' +
                    '<tbody id="embassy-coverage-body"><tr><td colspan="5" class="coverage-empty">Loading publications…</td></tr></tbody>' +
                    '</table></div>';

                fetch('data/data_manifest.json', { cache: 'no-store' })
                    .then(function(r) { return r.ok ? r.json() : null; })
                    .then(function(manifest) {
                        var offices = (manifest && manifest.offices) || [];
                        if (!offices.length) throw new Error('no manifest');
                        _embassyManifest = offices;
                        renderEmbassyCoverageTable();
                    })
                    .catch(function() {
                        _embassyManifest = null;
                        var coverageBody = document.getElementById('embassy-coverage-body');
                        if (coverageBody) coverageBody.innerHTML = '<tr><td colspan="5" class="coverage-empty">Coverage data is unavailable right now. <a href="/data/data_manifest.json">Open the manifest</a>.</td></tr>';
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

                var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                function formatDate(value) {
                    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
                    if (!match) return '—';
                    return Number(match[3]) + ' ' + (months[Number(match[2]) - 1] || '') + ' ' + match[1];
                }
                function sourceCell(office) {
                    var links = [];
                    if (office.source_url) {
                        links.push('<a href="' + escapeHtml(office.source_url) + '" target="_blank" rel="noopener noreferrer">Office page</a>');
                    }
                    if (office.source_file) {
                        links.push('<a href="' + escapeHtml(office.source_file) + '" target="_blank" rel="noopener noreferrer">Published file</a>');
                    }
                    return links.length ? links.join(' · ') : 'Not recorded';
                }

                body.innerHTML = order.map(function(slug) {
                    var office = bySlug[slug];
                    if (!office) {
                        return '<tr><td><strong>' + escapeHtml(slug.replace(/-/g, ' ')) + '</strong></td><td>—</td><td class="num">—</td><td>—</td><td>—</td></tr>';
                    }
                    return '<tr>' +
                        '<td><strong>' + escapeHtml(office.name || slug) + '</strong></td>' +
                        '<td>' + formatDate(office.report_date) + '</td>' +
                        '<td class="num">' + Number(office.decisions || 0).toLocaleString() + '</td>' +
                        '<td>' + sourceCell(office) + '</td>' +
                        '<td>' + (office.fetched_at ? fmtISTStamp(office.fetched_at) : '—') + '</td>' +
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
                                '<a href="/contact#share-timeline">Share yours</a> to help others plan.</p>';
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
                        '<td class="mono"><time datetime="' + escapeHtml(r.date) + '">' + escapeHtml(humanDate(r.date)) + '</time></td>' +
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
                btn.hidden = true;
                if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return;

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
                        // Browsers without an install prompt simply do not show
                        // the control; an alert would be an implementation detail.
                        btn.hidden = true;
                    }
                });
            }

async function renderLandingPage() {
                document.title = 'Irish Visa Decision Tracker - Six Offices, Stamp 1G & Employment Permits';
                // Paint the cards IMMEDIATELY with placeholder stats - never
                // block on the network. Each card's meta line fills in as its
                // own fetch resolves (both are small static files, so this is
                // fast; the full visa history still loads on tracker entry).
                // Clicking a card works from the first paint.
                root.innerHTML =
                    '<div class="landing-wrap page-title-block">' +
                    '<h1>Published Irish visa decisions</h1>' +
                    '<p class="page-task">Search six offices by application number, or open a processing-date tracker.</p>' +
                    '<div class="landing-status" id="landing-status" aria-live="polite"><span class="note2">Checking today’s updates…</span></div>' +
                    '<form class="landing-search" id="landing-search" role="search" novalidate>' +
                    '<div class="searchbar landing-search-number">' + searchIcon() +
                    '<input type="text" id="landing-q" name="q" autocomplete="off" maxlength="200" aria-label="Search by application number" placeholder="Application number" required></div>' +
                    '<select class="landing-office-select" id="landing-office" name="office" aria-label="Visa office to search">' +
                    officeOptionsHTML(homeSearchOffice) + '</select>' +
                    '<button class="btn" type="submit">Search</button></form>' +
                    '<p class="landing-search-hint">Use the 8-digit number on your receipt; an IRL prefix is optional. <a href="/help#find-number">Where do I find it?</a></p>' +
                    '<div class="tracker-grid" aria-label="Trackers">' +
                    trackerCardHTML('visa', 'plane', 'Visa decisions',
                        'Search published decisions from six offices by application number.', 'Loading…', 'visa-meta', '') +
                    trackerCardHTML('1g', 'stamp', 'Stamp 1G processing',
                        'ISD processing date, current lag and a date estimate.', 'Loading…', 'g1-meta', 'g1') +
                    trackerCardHTML('permits', 'briefcase', 'Employment permits',
                        'DETE queue by permit category, with the current lag.', 'Loading…', 'permits-meta', 'permits') +
                    '</div>' +
                    '<p class="landing-alert-line"><strong>Decision alerts on Telegram.</strong> One message when your application is published. <a href="/?tracker=visa&amp;tab=alerts">Set up alerts</a>.</p>' +
                    '<section class="landing-publications" aria-labelledby="landing-publications-title">' +
                    '<div class="landing-publications-head"><div>' +
                    '<h2 id="landing-publications-title">Latest official publications</h2>' +
                    '<p class="note2">Last checked <span id="stat-updated">—</span></p>' +
                    '</div><a href="/status">Data status</a></div>' +
                    '<div class="embassy-status-grid" id="embassy-status-grid" role="group" aria-label="Office coverage table"></div>' +
                    '<p class="note2">Report dates vary by office. New Delhi, Abu Dhabi, Abuja and Ankara keep dated history; Beijing and Dublin publish a latest snapshot. <a href="/visa-processing-times">Dublin queue dates</a>.</p>' +
                    '</section>' +
                    '<div class="landing-foot">Source: official Irish visa office reports. Updated when the offices publish.</div></div>';
                wireChrome();                wireChrome();
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
                    if (!homeSearchTerm) {
                        if (q) q.focus();
                        return;
                    }
                    var selectedOffice = document.getElementById('landing-office');
                    homeSearchOffice = selectedOffice &&
                        (selectedOffice.value === 'all' || WATCH_OFFICES.indexOf(selectedOffice.value) !== -1)
                        ? selectedOffice.value : 'all';
                    activeTab = 'search';
                    saveRecentSearch(homeSearchTerm);
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
                            const newDelhiToday = newDelhiNow();
                            strip.innerHTML = landingStatusHTML(meta, grows, newDelhiToday ? newDelhiToday.date : '');
                        } catch (e) {
                            strip.innerHTML = '<span class="note2">Trackers updated daily ~' +
                                scheduleTimeNode(NEW_DELHI_UPDATE_HOUR, NEW_DELHI_FOLLOW_UP_MINUTE) + '.</span>';
                        }
                    }
                });
                // Initialize new landing page components
                initLandingComponents();
                ensureScrollableFocusable();
            }

            // Initial mount: build the task header and tab bar, then delegate all
            // tab-content rendering to the same painter used by switchTab().
            async function render() {
                // Landing + trackers own their skeleton/load/paint cycle and
                // return early - everything below is the visa tracker.
                if (activeTracker === 'home') { await renderLandingPage(); return; }
                if (activeTracker === '1g') { await renderG1Page(); return; }
                if (activeTracker === 'permits') { await renderPermitsPage(); return; }
                document.title = 'Visa Decision Search - Six Offices | Irish Visa Decision Tracker';
                if (!cache) {
                    root.innerHTML =
                        '<div class="page-title-block">' +
                        '<h1>Visa decisions</h1>' +
                        '<p class="page-task">Search published decisions from six Irish offices by application number.</p>' +
                        '<p class="page-meta">Loading the current official files…</p>' +
                        '</div>' +
                        '<div class="navpills" aria-hidden="true">' +
                        '<div class="skel skel-pill"></div><div class="skel skel-pill"></div><div class="skel skel-pill"></div>' +
                        '<div class="skel skel-pill"></div><div class="skel skel-pill"></div><div class="skel skel-pill"></div>' +
                        '</div>' +
                        '<div class="skel-wrap">' +
                        '<div class="skel skel-row" style="width:70%"></div>' +
                        '<div class="skel skel-row" style="width:55%"></div>' +
                        '<div class="skel skel-row" style="width:65%"></div>' +
                        '</div>';
                }
                await loadData();
                loadMeta(); // health card / reconciliation / closures (non-blocking)

                destroyAnalyticsCharts();
                root.innerHTML =
                    BACK_BTN_HTML +
                    '<div class="page-title-block">' +
                    '<h1>Visa decisions</h1>' +
                    '<p class="page-task">Search published decisions from six Irish offices by application number.</p>' +
                    '<p class="page-meta">' + (cache && cache.length ? cache.length.toLocaleString() + ' decisions on record' : 'Awaiting data') +
                    ' · Compare each result with the official report date</p>' +
                    '</div>' +
                    '<nav class="navpills" aria-label="Visa tracker sections">' + TABS.map(function(tab) {
                        return '<button type="button" class="navpill ' + (activeTab === tab.id ? 'active' : '') +
                            '" data-tab="' + tab.id + '"' + (activeTab === tab.id ? ' aria-current="page"' : '') +
                            '>' + tab.label + '</button>';
                    }).join('') + '</nav>' +
                    '<div id="tab-body"></div>' +
                    '<button class="scroll-top-btn" id="scroll-top-btn" title="Back to top" aria-label="Back to top">↑</button>';

                TABS.forEach(function(tab) {
                    var pill = root.querySelector('.navpill[data-tab="' + tab.id + '"]');
                    pill.addEventListener('click', function() { switchTab(tab.id); });
                });
                wireChrome();
                paintTabBody(activeTab, cache || []);
                markVisited();
            }

            root.setAttribute('data-theme', theme);
            applyChrome();
            document.addEventListener('visa:themechange', function (event) {
                theme = event.detail && event.detail.theme === 'dark' ? 'dark' : 'light';
                root.setAttribute('data-theme', theme);
                applyChrome();
            });

            // Browser back/forward restores the tracker, tab and filters from
            // the URL. A tracker change needs a full render (different page),
            // a tab/filter change reuses the in-place switchTab().
            window.addEventListener('popstate', function() {
                const s = readUrlState();
                if (s.tracker !== activeTracker) {
                    activeTracker = s.tracker;
                    activeTab = s.tab;
                    activeView = s.view;
                    homeSearchTerm = s.q;
                    homeSearchOffice = s.office;
                    pastDateFilter = s.date;
                    render();
                    return;
                }
                if (s.tab === activeTab && s.view === activeView && s.q === homeSearchTerm &&
                    s.office === homeSearchOffice && s.date === pastDateFilter) return;
                activeTab = s.tab;
                activeView = s.view;
                homeSearchTerm = s.q;
                homeSearchOffice = s.office;
                pastDateFilter = s.date;
                switchTab(activeTab, { noUrl: true });
            });

            migrateWatchlist();
            window.addEventListener('storage', function(e) {
                if (e.key !== 'visa-watchlist') return;
                paintWatchlist();
            });
            render();
        })();
