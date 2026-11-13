/**
 * VFS Global appointment-page check.
 *
 * VFS does not publish the Ireland-India appointment calendar publicly. The
 * booking page is behind an account sign-in, and direct requests are usually
 * answered with a Cloudflare challenge. This module therefore reports only what
 * it can actually prove from the official page: the page is reachable, it
 * requires sign-in, it is challenged, it reports no slots, or it shows calendar
 * language. It never invents a date or a slot.
 *
 * If Cloudflare Browser Rendering is configured (CF_ACCOUNT_ID and
 * CF_API_TOKEN), the rendered page is inspected first. Otherwise the direct
 * HTTP response is classified. The official booking and tracking links are
 * always returned.
 */

const OFFICES = {
  'new-delhi': { name: 'New Delhi', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  mumbai: { name: 'Mumbai', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  chennai: { name: 'Chennai', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  kolkata: { name: 'Kolkata', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  bangalore: { name: 'Bangalore', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  bengaluru: { name: 'Bengaluru', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  hyderabad: { name: 'Hyderabad', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  pune: { name: 'Pune', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  ahmedabad: { name: 'Ahmedabad', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  jalandhar: { name: 'Jalandhar', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  chandigarh: { name: 'Chandigarh', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' },
  cochin: { name: 'Cochin', url: 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment' }
};

const TRACK_URL = 'https://visa.vfsglobal.com/ind/en/irl/track-application';
const LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/irl/login';
const DEFAULT_OFFICE = 'new-delhi';
const DISCLAIMER = 'VFS does not publish Ireland-India appointment slots publicly. This check reports the public page state only; it cannot hold or confirm a slot. Sign in to the official VFS portal to see the calendar.';

function normalizeOffice(value) {
  const key = String(value || DEFAULT_OFFICE).trim().toLowerCase().replace(/\s+/g, '-');
  return OFFICES[key] ? key : null;
}

function loginRequired(message) {
  return {
    availability: 'login_required',
    confidence: 'high',
    message: message || 'VFS requires an account sign-in before it shows the appointment calendar. No public slot data is available.'
  };
}

function classify(text, status) {
  const body = String(text || '').replace(/\s+/g, ' ');
  const httpStatus = Number(status) || 0;

  if (httpStatus === 403 || httpStatus === 429 ||
      /cf-chl|just a moment|challenge-platform|enable javascript and cookies|checking your browser/i.test(body)) {
    return {
      availability: 'challenge',
      confidence: 'none',
      message: 'VFS returned a bot challenge. Open the official page in a browser to sign in and see the calendar.'
    };
  }

  if (httpStatus === 401) {
    return loginRequired('VFS returned an authentication-required response. Sign in on the official page to see the appointment calendar.');
  }

  if (httpStatus >= 500 ||
      /maintenance|temporarily unavailable|service unavailable|technical error|bad gateway/i.test(body)) {
    return {
      availability: 'maintenance',
      confidence: 'low',
      message: 'VFS appears to be in maintenance or temporarily unavailable.'
    };
  }

  if (/no appointments? (?:are )?(?:currently )?available|no slots? available|currently no appointments?|appointment slots? (?:are )?(?:currently )?unavailable/i.test(body)) {
    return {
      availability: 'unavailable',
      confidence: 'medium',
      message: 'The VFS page reports no appointments available right now.'
    };
  }

  // Strong sign-in signals. The booking page links to /login even before the
  // calendar exists, so a login link plus "Book now" is a login-required state,
  // not an appointment signal.
  if (/(?:sign in|log in).{0,160}(?:email|password)|(?:email|password).{0,160}(?:sign in|log in)|forgot password|activate my account|\/login(?:\?|["'#/])/i.test(body)) {
    return loginRequired();
  }

  if (/earliest available|available appointment|select (?:a |your )?(?:date|time|slot)|choose (?:a |your )?(?:date|time|slot)|available dates?|appointment calendar/i.test(body)) {
    return {
      availability: 'available',
      confidence: 'medium',
      message: 'The VFS page contains booking-calendar language. Confirm the actual date and time on the official page.'
    };
  }

  if (/book(?: an)? appointment|appointment/i.test(body)) {
    return {
      availability: 'unknown',
      confidence: 'low',
      message: 'The official booking page is reachable, but it does not expose slot data to an unauthenticated request.'
    };
  }

  return {
    availability: 'unknown',
    confidence: 'none',
    message: 'The official page returned no recognizable appointment signal.'
  };
}

function renderingCredentials(env) {
  const accountId = env && (env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID);
  const token = env && (env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN);
  return accountId && token ? { accountId, token } : null;
}

async function fetchRendered(url, env, fetchImpl = fetch) {
  const credentials = renderingCredentials(env);
  if (!credentials) return null;

  const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' +
    encodeURIComponent(credentials.accountId) + '/browser-rendering/content';
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + credentials.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
      waitForTimeout: 3000
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Browser Rendering ' + response.status + ': ' + detail.slice(0, 200));
  }
  const payload = await response.json();
  const result = payload && payload.result;
  return {
    text: typeof result === 'string' ? result : String((result && (result.content || result.html)) || ''),
    source: 'browser-rendering'
  };
}

async function fetchPage(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IrishVisaTracker/1.0; +https://irishvisaupdatetracker.pages.dev)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-IN,en;q=0.9'
      }
    });
    const text = await response.text();
    return { text, status: response.status, finalUrl: response.url, source: 'http' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check one office. Exported separately from the HTTP handler so the scheduler
 * or a future monitor can reuse the exact same classification rules.
 */
export async function checkVFSAppointment(options = {}) {
  const { env = {}, fetchImpl = fetch } = options;
  const officeKey = normalizeOffice(options.office || options.officeKey);
  if (!officeKey) {
    return {
      success: false,
      error: 'Unknown VFS office',
      status: 400
    };
  }

  const office = OFFICES[officeKey];
  const visaType = String(options.visaType || options.visa_type || '').trim().slice(0, 80);
  let page;
  let source = 'http';
  let renderError = null;

  try {
    const rendered = await fetchRendered(office.url, env, fetchImpl);
    if (rendered) {
      page = rendered;
      source = rendered.source;
    }
  } catch (error) {
    renderError = error.message;
    console.warn('VFS browser rendering failed:', error.message);
  }

  if (!page) {
    try {
      page = await fetchPage(office.url, fetchImpl);
      source = page.source;
    } catch (error) {
      return {
        success: false,
        office: officeKey,
        office_name: office.name,
        visa_type: visaType || null,
        availability: 'unknown',
        confidence: 'none',
        error: 'Could not reach the official VFS page',
        detail: error.name === 'AbortError' ? 'Request timed out' : error.message,
        message: 'The official VFS page could not be reached. Try again or open it directly.',
        official_url: office.url,
        booking_url: office.url,
        login_url: LOGIN_URL,
        tracking_url: TRACK_URL,
        source,
        http_status: null,
        render_error: renderError,
        requires_login: false,
        calendar_visible: false,
        public_slots: false,
        checked_at: new Date().toISOString(),
        disclaimer: DISCLAIMER
      };
    }
  }

  const result = classify(page.text, page.status);
  return {
    success: true,
    office: officeKey,
    office_name: office.name,
    visa_type: visaType || null,
    availability: result.availability,
    confidence: result.confidence,
    message: result.message,
    official_url: office.url,
    booking_url: office.url,
    login_url: LOGIN_URL,
    tracking_url: TRACK_URL,
    source,
    http_status: page.status || null,
    render_error: renderError,
    requires_login: result.availability === 'login_required',
    calendar_visible: result.availability === 'available' || result.availability === 'unavailable',
    public_slots: false,
    checked_at: new Date().toISOString(),
    disclaimer: DISCLAIMER
  };
}

export async function handleVFSAppointments(request, env = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'GET, HEAD' }
    });
  }

  const url = new URL(request.url);
  const officeKey = normalizeOffice(url.searchParams.get('office') || url.searchParams.get('embassy'));
  if (!officeKey) {
    return new Response(JSON.stringify({
      error: 'Unknown VFS office',
      offices: Object.entries(OFFICES).map(([slug, office]) => ({ slug, name: office.name }))
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const result = await checkVFSAppointment({
    office: officeKey,
    visaType: url.searchParams.get('visa_type'),
    env
  });
  const status = result.success ? 200 : (result.status === 400 ? 400 : 502);
  return new Response(JSON.stringify(result), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300'
    }
  });
}

export { OFFICES, classify, normalizeOffice };
