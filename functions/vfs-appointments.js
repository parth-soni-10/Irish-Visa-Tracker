/**
 * VFS Global appointment handoff.
 *
 * VFS does not publish the Ireland-India appointment calendar. The booking
 * calendar is visible only after signing in to the official VFS portal. This
 * module therefore returns a static handoff: it makes no outbound request,
 * stores no VFS credentials and never infers a slot.
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
const MESSAGE = 'VFS shows appointment slots only after signing in. This tracker cannot see, hold, or book a slot.';

function normalizeOffice(value) {
  const key = String(value || DEFAULT_OFFICE).trim().toLowerCase().replace(/\s+/g, '-');
  return OFFICES[key] ? key : null;
}

/**
 * Return the same static handoff for every supported office. Kept as an
 * exported function so existing callers and tests do not need to know about
 * the HTTP handler.
 */
export async function checkVFSAppointment(options = {}) {
  const officeKey = normalizeOffice(options.office || options.officeKey);
  if (!officeKey) {
    return {
      success: false,
      error: 'Unknown VFS office',
      status: 400
    };
  }

  const visaType = String(options.visaType || options.visa_type || '').trim().slice(0, 80) || null;
  const bookingUrl = OFFICES[officeKey].url;

  return {
    success: true,
    office: officeKey,
    office_name: OFFICES[officeKey].name,
    visa_type: visaType,
    availability: 'login_required',
    message: MESSAGE,
    official_url: bookingUrl,
    booking_url: bookingUrl,
    login_url: LOGIN_URL,
    tracking_url: TRACK_URL,
    requires_login: true,
    public_slots: false,
    calendar_visible: false
  };
}

export async function handleVFSAppointments(request) {
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
    visaType: url.searchParams.get('visa_type')
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300'
    }
  });
}

export { OFFICES, normalizeOffice };
