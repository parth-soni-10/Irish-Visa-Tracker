/**
 * VFS Global appointment availability.
 *
 * VFS renders the booking calendar in JavaScript. A plain fetch cannot read
 * the final slot list, so this endpoint returns an explicit availability signal
 * from the official VFS page. If CLOUDFLARE_BROWSER_RENDERING credentials are
 * configured it renders the page first; otherwise it reports `unknown` rather
 * than inventing a slot. The official booking URL is always returned.
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

function normalizeOffice(value) {
  const key = String(value || 'new-delhi').trim().toLowerCase().replace(/\s+/g, '-');
  return OFFICES[key] ? key : null;
}

function classify(text, status) {
  const body = String(text || '').replace(/\s+/g, ' ');
  if (status === 403 || /cf-chl|just a moment|challenge-platform|enable javascript and cookies/i.test(body)) {
    return {
      availability: 'challenge',
      confidence: 'none',
      message: 'VFS returned a bot challenge. Open the official page in a browser to see the calendar.'
    };
  }
  if (/maintenance|temporarily unavailable|service unavailable|technical error/i.test(body)) {
    return {
      availability: 'maintenance',
      confidence: 'low',
      message: 'VFS appears to be in maintenance or temporarily unavailable.'
    };
  }
  if (/no appointments? (?:are )?(?:currently )?available|no slots? available|currently no appointments?/i.test(body)) {
    return {
      availability: 'unavailable',
      confidence: 'medium',
      message: 'VFS page reports no appointments available right now.'
    };
  }
  if (/earliest available|available appointment|select (?:a|your) (?:date|time|slot)|choose (?:a|your) (?:date|time|slot)/i.test(body)) {
    return {
      availability: 'available',
      confidence: 'medium',
      message: 'VFS page contains booking-calendar language. Confirm the slot on the official page.'
    };
  }
  if (/book an appointment|appointment/i.test(body)) {
    return {
      availability: 'unknown',
      confidence: 'low',
      message: 'The official booking page is reachable, but the slot calendar is JavaScript-rendered.'
    };
  }
  return {
    availability: 'unknown',
    confidence: 'none',
    message: 'The official page returned no recognizable appointment signal.'
  };
}

async function fetchRendered(url, env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return null;
  const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' +
    encodeURIComponent(env.CF_ACCOUNT_ID) + '/browser-rendering/content';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.CF_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
      waitForTimeout: 2500
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Browser Rendering ' + response.status + ': ' + detail.slice(0, 200));
  }
  const payload = await response.json();
  return {
    text: String((payload && payload.result) || ''),
    source: 'browser-rendering'
  };
}

async function fetchPage(url, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
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

export async function handleVFSAppointments(request, env) {
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

  const office = OFFICES[officeKey];
  const visaType = String(url.searchParams.get('visa_type') || '').trim().slice(0, 80);
  let page;
  let source = 'http';
  let renderError = null;

  try {
    const rendered = await fetchRendered(office.url, env);
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
      page = await fetchPage(office.url, env);
      source = page.source;
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        office: officeKey,
        office_name: office.name,
        availability: 'unavailable',
        confidence: 'none',
        error: 'Could not reach the official VFS page',
        detail: error.name === 'AbortError' ? 'Request timed out' : error.message,
        official_url: office.url,
        booking_url: office.url,
        tracking_url: TRACK_URL,
        checked_at: new Date().toISOString()
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
  }

  const result = classify(page.text, page.status);
  return new Response(JSON.stringify({
    success: true,
    office: officeKey,
    office_name: office.name,
    visa_type: visaType || null,
    availability: result.availability,
    confidence: result.confidence,
    message: result.message,
    official_url: office.url,
    booking_url: office.url,
    tracking_url: TRACK_URL,
    source,
    http_status: page.status || null,
    render_error: renderError,
    checked_at: new Date().toISOString(),
    disclaimer: 'Availability changes quickly. This is an unauthenticated signal from the public VFS page, not a held slot or a guarantee. Confirm on the official VFS booking page.'
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300'
    }
  });
}

export { OFFICES, classify };
