/**
 * Optional SMS / WhatsApp delivery through Twilio's REST API.
 *
 * Missing credentials are a normal, explicit state. The caller receives
 * `disabled: true` and can show a setup message instead of pretending a
 * message was sent. Phone numbers are never logged.
 */

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01/Accounts/';

function credentials(env, channel) {
  const sid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const from = channel === 'whatsapp'
    ? String(env.TWILIO_WHATSAPP_FROM || '').trim()
    : String(env.TWILIO_SMS_FROM || '').trim();
  return { sid, token, from };
}

export function isChannelConfigured(env, channel) {
  const value = credentials(env, channel);
  return Boolean(value.sid && value.token && value.from);
}

export function anyChannelConfigured(env) {
  return isChannelConfigured(env, 'sms') || isChannelConfigured(env, 'whatsapp');
}

function cleanAddress(channel, address) {
  let value = String(address || '').trim().replace(/^whatsapp:/i, '');
  value = value.replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return '';
  return channel === 'whatsapp' ? 'whatsapp:' + value : value;
}

async function basicAuth(env) {
  const { sid, token } = credentials(env, 'sms');
  return 'Basic ' + btoa(sid + ':' + token);
}

export async function sendChannel(env, channel, address, body) {
  const type = channel === 'whatsapp' ? 'whatsapp' : 'sms';
  const configured = credentials(env, type);
  if (!configured.sid || !configured.token || !configured.from) {
    return { sent: 0, disabled: true, error: type + ' delivery is not configured' };
  }
  const to = cleanAddress(type, address);
  if (!to) return { sent: 0, disabled: false, error: 'A valid international phone number is required (for example +353...)' };
  const message = String(body || '').trim().slice(0, 1500);
  if (!message) return { sent: 0, disabled: false, error: 'Message body is empty' };

  const form = new URLSearchParams({
    To: to,
    From: configured.from.startsWith('whatsapp:') ? configured.from : (type === 'whatsapp' ? 'whatsapp:' + configured.from : configured.from),
    Body: message
  });
  try {
    const response = await fetch(TWILIO_BASE + encodeURIComponent(configured.sid) + '/Messages.json', {
      method: 'POST',
      headers: {
        Authorization: await basicAuth(env),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString(),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { sent: 0, disabled: false, error: 'Twilio rejected the message (' + response.status + '): ' + detail.slice(0, 160) };
    }
    const data = await response.json().catch(() => ({}));
    return { sent: 1, disabled: false, sid: data.sid || null };
  } catch (error) {
    return { sent: 0, disabled: false, error: 'Twilio request failed: ' + String(error.message || error).slice(0, 160) };
  }
}

export async function sendChannelTest(env, channel, address) {
  return sendChannel(
    env,
    channel,
    address,
    'Irish Visa Tracker test: this channel is connected for your account. Reply STOP to opt out with your provider.'
  );
}
