// ============================================================
// Internationalization (i18n) Module - Inlined
// ============================================================
const TRANSLATIONS = {
  en: {
    'app.title': 'Irish Visa Decision Tracker',
    'app.subtitle': 'Search visa decisions by application number',
    'app.description': 'Track Embassy of Ireland visa decisions, Stamp 1G processing, and employment permits.',
    'nav.home': 'Home',
    'nav.daily': 'Daily Summary',
    'nav.past': 'Past Results',
    'nav.analytics': 'Analytics',
    'nav.suggestions': 'Suggestions',
    'nav.vac': 'VAC & Transit',
    'nav.stamp1g': 'Stamp 1G',
    'nav.permits': 'Employment Permits',
    'common.search': 'Search',
    'common.export': 'Export',
    'common.export.csv': 'Export CSV',
    'common.export.excel': 'Export Excel',
    'common.export.pdf': 'Export PDF',
    'common.clear': 'Clear',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.retry': 'Retry',
    'common.close': 'Close',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.submit': 'Submit',
    'common.days': 'days',
    'common.weeks': 'weeks',
    'common.months': 'months',
    'home.latest_data': 'Latest available data',
    'home.tracking_since': 'Tracking started',
    'home.search_placeholder': 'Search by application number...',
    'home.search_aria': 'Search by application number',
    'home.no_results': 'No matches.',
    'home.nearest_neighbours': 'Nearest neighbours',
    'home.no_exact_match': 'No exact match for',
    'home.day_on_day': 'Day-on-day change',
    'home.avg_per_day': 'Avg applications/day',
    'home.acceptance_rate': 'Acceptance rate',
    'home.rejection_rate': 'Rejection rate',
    'home.latest_file': 'The latest Excel file from the embassy contains decisions up to',
    'home.embassy_uploads': 'The Irish Embassy typically uploads the Excel file at',
    'home.check_around': 'For the freshest updates, check this page around',
    'home.sorted_by_appnum': 'The embassy\'s Excel file is sorted by application number, not decision date',
    'daily.title': 'Daily Summary',
    'daily.date': 'Date',
    'daily.applications': 'Applications Processed',
    'daily.day_on_day': 'Day-on-Day',
    'daily.acceptance': 'Acceptance Rate',
    'daily.rejection': 'Rejection Rate',
    'daily.heatmap': 'Decisions per day, last 14 weeks',
    'daily.more': 'more',
    'daily.less': 'less',
    'past.title': 'Past Results',
    'past.filter_date': 'Filter by date',
    'past.filter_status': 'Filter by status',
    'past.all': 'All',
    'past.accepted': 'Accepted',
    'past.rejected': 'Rejected',
    'past.other': 'Other',
    'past.results_count': 'results',
    'past.for_date': 'for',
    'past.total': 'total',
    'analytics.title': 'Analytics',
    'analytics.monthly': 'Month-by-Month Approval Rate',
    'analytics.rolling30': '30-Day Rolling Approval Rate',
    'analytics.daily_delta': 'Daily Volume Delta',
    'analytics.queue_density': 'Queue Density (Application Number Distribution)',
    'analytics.month': 'Month',
    'analytics.total': 'Total Applications',
    'analytics.approved': 'Approved',
    'analytics.rate': 'Rate (%)',
    'analytics.volume': 'Volume',
    'analytics.date': 'Date',
    'analytics.range': 'Application Number Range',
    'analytics.count': 'Count',
    'stamp1g.title': 'Stamp 1G Tracker',
    'stamp1g.processing': 'Processing',
    'stamp1g.lag': 'Current lag',
    'stamp1g.advancement': 'Advancement rate',
    'stamp1g.eta': 'ETA to today',
    'stamp1g.your_application': 'Your application',
    'stamp1g.applied': 'I applied',
    'stamp1g.plan': 'I plan to apply',
    'stamp1g.application_date': 'Application date',
    'stamp1g.buffer': 'Buffer',
    'stamp1g.weeks_on_top': 'weeks on top of the current lag',
    'stamp1g.estimate': 'Estimated outcome',
    'stamp1g.expiry': 'IRP expiry (optional)',
    'stamp1g.share_timeline': 'Share your timeline',
    'stamp1g.applied_on': 'Applied on',
    'stamp1g.decided_on': 'Decided on',
    'stamp1g.outcome': 'Outcome',
    'stamp1g.granted': 'Granted',
    'stamp1g.refused': 'Refused',
    'stamp1g.share': 'Share Timeline',
    'stamp1g.applied_on': 'Applied on',
    'stamp1g.decided_on': 'Decided on',
    'stamp1g.outcome': 'Outcome',
    'stamp1g.granted': 'Granted',
    'stamp1g.refused': 'Refused',
    'stamp1g.share': 'Share Timeline',
    'permits.title': 'Employment Permits',
    'permits.category': 'Category',
    'permits.processing_date': 'Permit date',
    'permits.lag_days': 'Lag (days)',
    'permits.share_timeline': 'Share your timeline',
    'suggestions.title': 'Suggestions',
    'suggestions.name': 'Name',
    'suggestions.name_placeholder': 'Your name...',
    'suggestions.text': 'Suggestion',
    'suggestions.text_placeholder': 'Your suggestion...',
    'suggestions.send': 'Send Suggestion',
    'suggestions.share_timeline': 'Share your timeline',
    'suggestions.get_alerts': 'Get Decision Alerts',
    'suggestions.email': 'Email',
    'suggestions.email_placeholder': 'you@example.com',
    'suggestions.app_number': 'Application Number',
    'suggestions.app_placeholder': '12345678',
    'suggestions.visa_office': 'Visa Office',
    'suggestions.enable_alerts': 'Enable Alerts',
    'suggestions.enter_email_app': 'Enter your email and application number. We will email you the moment a decision is published.',
    'alerts.title': 'Get Decision Alerts',
    'alerts.enter_email': 'Enter your email and application number.',
    'alerts.we_will_email': 'We will email you the moment a decision is published.',
    'alerts.email': 'Email',
    'alerts.app_number': 'Application Number',
    'alerts.visa_office': 'Visa Office',
    'alerts.enable': 'Enable Alerts',
    'vac.title': 'VAC & Transit Guidance',
    'vac.subtitle': 'Find your nearest Visa Application Centre, check transit visa requirements, and plan your travel to Ireland.',
    'vac.overview': 'Overview',
    'vac.transit': 'Transit Visas',
    'vac.total_vacs': 'Total VACs Worldwide',
    'vac.countries_served': 'Countries Served',
    'vac.processing_time': 'Processing Time',
    'vac.service_fee': 'Service Fee',
    'vac.vac_locations': 'VAC Locations',
    'vac.required_documents': 'Required Documents',
    'vac.avg_processing': 'Avg Processing',
    'vac.service_fee_label': 'Service Fee',
    'vac.who_needs_transit': 'Who Needs a Transit Visa?',
    'vac.exemptions': 'Exemptions',
    'vac.max_stay': 'Max Stay',
    'vac.visa_type': 'Visa Type',
    'vac.fee': 'Fee',
    'vac.important_notes': 'Important Notes',
    'vac.airside_transit': 'Airside transit (not leaving the airport) still requires a transit visa for listed nationalities',
    'vac.landsite_visa': 'If you leave the airport (landside), you need a regular short-stay \'C\' visa',
    'vac.transit_no_entry': 'Transit visa does not permit entry into Ireland for tourism/business',
    'vac.apply_at_vac': 'Apply at the VAC for your country of residence, not the transit country',
    'status.published': 'published',
    'status.expected': 'expected',
    'status.closed': 'Embassy closed',
    'status.pub_live': 'Today\'s file: published',
    'status.pub_late': 'Today\'s file: not yet published',
    'status.stale': 'Using cached data',
    'status.retrying': 'Retrying...',
    'status.retry_now': 'Retry now',
    'watch.heads_up': 'Heads up:',
    'watch.was': 'was',
    'watch.on': 'on',
    'watch.add': 'Watch',
    'watch.watched': 'Watched:',
    'watch.remove': 'Stop watching',
    'export.success': 'Export completed',
    'export.failed': 'Export failed',
    'timeline.share': 'Share your timeline',
    'timeline.applied': 'Applied on',
    'timeline.decided': 'Decided on',
    'timeline.outcome': 'Outcome',
    'timeline.granted': 'Granted',
    'timeline.refused': 'Refused',
    'timeline.submit': 'Share Timeline',
    'timeline.embassy_only': 'Embassy visa only - applied and decided dates from the New Delhi list. Published anonymously in aggregate.',
    'timeline.1g_only': 'Stamp 1G renewals only - when did you apply, and when was it decided? Published anonymously in aggregate.',
    'error.fill_dates': 'Please fill in both dates.',
    'error.invalid_app': 'Invalid application number.',
    'error.network': 'Network error. Please try again.',
    'lang.select': 'Language',
    'lang.en': 'English',
    'lang.hi': 'हिन्दी (Hindi)',
    'lang.zh': '中文 (Chinese)',
    'lang.ar': 'العربية (Arabic)',
    'lang.tr': 'Türkçe (Turkish)',
    'lang.fr': 'Français (French)',
    'lang.es': 'Español (Spanish)',
    'lang.ur': 'اردو (Urdu)',
  },
  hi: {
    'app.title': 'आयरिश वीज़ा निर्णय ट्रैकर',
    'app.subtitle': 'आवेदन संख्या से वीज़ा निर्णय खोजें',
    'nav.home': 'होम',
    'nav.daily': 'दैनिक सारांश',
    'nav.past': 'पिछले परिणाम',
    'nav.analytics': 'विश्लेषण',
    'nav.suggestions': 'सुझाव',
    'nav.vac': 'वीएसी और ट्रांज़िट',
    'common.search': 'खोजें',
    'common.export.csv': 'CSV निर्यात करें',
    'common.export.excel': 'Excel निर्यात करें',
    'common.export.pdf': 'PDF निर्यात करें',
    'home.search_placeholder': 'आवेदन संख्या से खोजें...',
    'home.no_results': 'कोई परिणाम नहीं।',
    'daily.title': 'दैनिक सारांश',
    'past.title': 'पिछले परिणाम',
    'analytics.title': 'विश्लेषण',
    'stamp1g.title': 'स्टाम्प 1G ट्रैकर',
    'permits.title': 'रोजगार परमिट',
    'vac.title': 'वीएसी और ट्रांज़िट मार्गदर्शन',
    'status.published': 'प्रकाशित',
  },
  zh: {
    'app.title': '爱尔兰签证决定追踪器',
    'app.subtitle': '按申请编号搜索签证决定',
    'nav.home': '首页',
    'nav.daily': '每日摘要',
    'nav.past': '历史结果',
    'nav.analytics': '分析',
    'nav.suggestions': '建议',
    'nav.vac': '签证中心与过境',
    'common.search': '搜索',
    'common.export.csv': '导出 CSV',
    'common.export.excel': '导出 Excel',
    'common.export.pdf': '导出 PDF',
    'home.search_placeholder': '按申请编号搜索...',
    'home.no_results': '无匹配结果。',
    'daily.title': '每日摘要',
    'past.title': '历史结果',
    'analytics.title': '分析',
    'stamp1g.title': 'Stamp 1G 追踪器',
    'permits.title': '工作许可',
    'vac.title': '签证申请中心与过境指南',
    'status.published': '已发布',
  },
  ar: {
    'app.title': 'متتبع قرارات التأشيرة الأيرلندية',
    'app.subtitle': 'البحث عن قرارات التأشيرة برقم الطلب',
    'nav.home': 'الرئيسية',
    'nav.daily': 'الملخص اليومي',
    'nav.past': 'النتائج السابقة',
    'nav.analytics': 'التحليلات',
    'nav.suggestions': 'الاقتراحات',
    'nav.vac': 'مركز التأشيرات والعبور',
    'common.search': 'بحث',
    'common.export.csv': 'تصدير CSV',
    'common.export.excel': 'تصدير Excel',
    'common.export.pdf': 'تصدير PDF',
    'home.search_placeholder': 'البحث برقم الطلب...',
    'home.no_results': 'لا توجد نتائج.',
    'daily.title': 'الملخص اليومي',
    'past.title': 'النتائج السابقة',
    'analytics.title': 'التحليلات',
    'stamp1g.title': 'متتبع Stamp 1G',
    'permits.title': 'تصاريح العمل',
    'vac.title': 'دليل مراكز التأشيرات والعبور',
    'status.published': 'منشور',
  },
  tr: {
    'app.title': 'İrlanda Vize Karar Takipçisi',
    'app.subtitle': 'Başvuru numarası ile vize kararlarını arayın',
    'nav.home': 'Ana Sayfa',
    'nav.daily': 'Günlük Özet',
    'nav.past': 'Geçmiş Sonuçlar',
    'nav.analytics': 'Analitik',
    'nav.suggestions': 'Öneriler',
    'nav.vac': 'VAC ve Transit',
    'common.search': 'Ara',
    'common.export.csv': 'CSV Dışa Aktar',
    'common.export.excel': 'Excel Dışa Aktar',
    'common.export.pdf': 'PDF Dışa Aktar',
    'home.search_placeholder': 'Başvuru numarası ile ara...',
    'home.no_results': 'Eşleşme bulunamadı.',
    'daily.title': 'Günlük Özet',
    'past.title': 'Geçmiş Sonuçlar',
    'analytics.title': 'Analitik',
    'stamp1g.title': 'Stamp 1G Takipçisi',
    'permits.title': 'Çalışma İzinleri',
    'vac.title': 'VAC ve Transit Rehberi',
    'status.published': 'Yayınlandı',
  },
  fr: {
    'app.title': 'Suivi des Décisions de Visa Irlandais',
    'app.subtitle': 'Rechercher les décisions de visa par numéro de demande',
    'nav.home': 'Accueil',
    'nav.daily': 'Résumé Quotidien',
    'nav.past': 'Résultats Précédents',
    'nav.analytics': 'Analytiques',
    'nav.suggestions': 'Suggestions',
    'nav.vac': 'CVAC et Transit',
    'common.search': 'Rechercher',
    'common.export.csv': 'Exporter CSV',
    'common.export.excel': 'Exporter Excel',
    'common.export.pdf': 'Exporter PDF',
    'home.search_placeholder': 'Rechercher par numéro de demande...',
    'home.no_results': 'Aucune correspondance.',
    'daily.title': 'Résumé Quotidien',
    'past.title': 'Résultats Précédents',
    'analytics.title': 'Analytiques',
    'stamp1g.title': 'Suivi Stamp 1G',
    'permits.title': 'Permis de Travail',
    'vac.title': 'CVAC et Transit',
    'status.published': 'Publié',
  },
  es: {
    'app.title': 'Rastreador de Decisiones de Visa Irlandesa',
    'app.subtitle': 'Buscar decisiones de visa por número de solicitud',
    'nav.home': 'Inicio',
    'nav.daily': 'Resumen Diario',
    'nav.past': 'Resultados Anteriores',
    'nav.analytics': 'Análisis',
    'nav.suggestions': 'Sugerencias',
    'nav.vac': 'VAC y Tránsito',
    'common.search': 'Buscar',
    'common.export.csv': 'Exportar CSV',
    'common.export.excel': 'Exportar Excel',
    'common.export.pdf': 'Exportar PDF',
    'home.search_placeholder': 'Buscar por número de solicitud...',
    'home.no_results': 'Sin coincidencias.',
    'daily.title': 'Resumen Diario',
    'past.title': 'Resultados Anteriores',
    'analytics.title': 'Análisis',
    'stamp1g.title': 'Rastreador Stamp 1G',
    'permits.title': 'Permisos de Trabajo',
    'vac.title': 'VAC y Tránsito',
    'status.published': 'Publicado',
  },
  ur: {
    'app.title': 'آئرلینڈی ویزا فیصلہ ٹریکر',
    'app.subtitle': 'درخواست نمبر سے ویزا فیصلے تلاش کریں',
    'nav.home': 'ہوم',
    'nav.daily': 'يومي خلاصه',
    'nav.past': 'پچھلے نتائج',
    'nav.analytics': 'تجزیہ',
    'nav.suggestions': 'تجاویز',
    'nav.vac': 'VAC اور ٹرانزٹ',
    'common.search': 'تلاش',
    'common.export.csv': 'CSV برآمد کریں',
    'common.export.excel': 'Excel برآمد کریں',
    'common.export.pdf': 'PDF برآمد کریں',
    'home.search_placeholder': 'درخواست نمبر سے تلاش کریں...',
    'home.no_results': 'کوئی میل نہیں۔',
    'daily.title': 'يومي خلاصه',
    'past.title': 'پچھلے نتائج',
    'analytics.title': 'تجزیہ',
    'stamp1g.title': 'اسٹیمپ 1G ٹریکر',
    'permits.title': 'ملازمت پرمٹ',
    'vac.title': 'VAC اور ٹرانزٹ رہنمائی',
    'status.published': 'شائع',
  }
};

let currentLang = 'en';

function t(key, params = {}) {
  const langTranslations = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  let text = langTranslations[key] || TRANSLATIONS.en[key] || key;
  if (params) {
    Object.entries(params).forEach(([param, value]) => {
      text = text.replace(new RegExp(`\\{${param}\\}`, 'g'), value);
    });
  }
  return text;
}

function setLanguage(lang) {
  if (TRANSLATIONS[lang]) {
    currentLang = lang;
    localStorage.setItem('preferred-language', lang);
    return true;
  }
  return false;
}

function getLanguage() {
  return currentLang;
}

function initLanguage() {
  const saved = localStorage.getItem('preferred-language');
  if (saved && TRANSLATIONS[saved]) {
    currentLang = saved;
  } else {
    const browserLang = navigator.language.split('-')[0];
    if (TRANSLATIONS[browserLang]) {
      currentLang = browserLang;
    }
  }
  return currentLang;
}

function translatePage() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translation = t(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'submit' || el.type === 'button') {
        el.value = translation;
      } else {
        el.placeholder = translation;
      }
    } else {
      el.textContent = translation;
    }
  });
  document.title = t('app.title');
  document.documentElement.lang = currentLang;
}

function createLanguageSelector() {
  const languages = getAvailableLanguages();
  return `
    <div class="lang-selector" style="position: relative;">
      <button class="lang-btn" aria-label="${t('lang.select')}" aria-expanded="false" aria-haspopup="listbox">
        <span class="lang-current">${languages.find(l => l.code === currentLang)?.nativeName || currentLang.toUpperCase()}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <ul class="lang-dropdown" role="listbox" aria-label="${t('lang.select')}" style="display: none;">
        ${languages.map(l => `
          <li role="option" data-lang="${l.code}" ${l.code === currentLang ? 'aria-selected="true"' : ''}>
            ${l.nativeName}
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function getAvailableLanguages() {
  return Object.keys(TRANSLATIONS).map(code => ({
    code,
    name: TRANSLATIONS[code]['lang.select'] || TRANSLATIONS[code]['lang.' + code] || code.toUpperCase(),
    nativeName: TRANSLATIONS[code]['lang.' + code] || code.toUpperCase()
  }));
}

// Export for global access
window.TRANSLATIONS = TRANSLATIONS;
window.currentLanguage = currentLang;
window.t = t;
window.setLanguage = setLanguage;
window.getLanguage = getLanguage;
window.getAvailableLanguages = getAvailableLanguages;
window.initLanguage = initLanguage;
window.translatePage = translatePage;
window.createLanguageSelector = createLanguageSelector;

// Initialize language immediately
initLanguage();
translatePage();

// Create language selector after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  var langBtn = document.querySelector('.lang-btn');
  if (langBtn && typeof createLanguageSelector === 'function') {
    langBtn.outerHTML = createLanguageSelector();
  }
});

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
    if (setLanguage(lang)) {
      translatePage();
    }
    langItem.closest('.lang-dropdown').style.display = 'none';
  }
});
