/**
 * Small provider-neutral alert sender.
 *
 * The URL and message are supplied by a monitor or a GitHub Actions job. The
 * payload is adapted to the common webhook formats so one repository secret
 * works with Slack, Teams, Discord, a Telegram bot or a generic gateway.
 * Alert URLs are never logged: they frequently contain a secret token.
 */

export function buildWebhookPayload(url, text) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'hooks.slack.com') return { text };
  if (host.endsWith('.webhook.office.com') || host === 'webhook.office.com') {
    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: 'Irish Visa Tracker monitor alert',
      text
    };
  }
  if (host === 'discord.com' || host === 'discordapp.com') {
    return { content: text, username: 'Visa Decision Tracker' };
  }
  if (host === 'api.telegram.org') {
    const chatId = new URL(url).searchParams.get('chat_id') || '';
    return { chat_id: chatId, text };
  }
  return { text };
}

export async function sendAlert(url, text, { fetchImpl = fetch } = {}) {
  if (!url) return { sent: false, reason: 'not-configured' };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Irish-Visa-Tracker-Monitor/1.0' },
    body: JSON.stringify(buildWebhookPayload(url, text))
  });
  if (!response.ok) {
    throw new Error(`Alert webhook returned HTTP ${response.status}`);
  }
  return { sent: true, status: response.status };
}
