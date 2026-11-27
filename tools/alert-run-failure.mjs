/**
 * Alert when a watched GitHub Actions workflow fails, whatever triggered it.
 *
 * The alert workflow supplies the failed run's metadata in environment
 * variables. No token, secret or request body is included in the message.
 */
import process from 'node:process';

import { sendAlert } from './alert-webhook.mjs';

const workflow = process.env.WORKFLOW_NAME || 'unknown workflow';
const conclusion = process.env.WORKFLOW_CONCLUSION || 'failure';
const event = process.env.WORKFLOW_EVENT || '';
const runUrl = process.env.WORKFLOW_RUN_URL || '';
const branch = process.env.WORKFLOW_BRANCH || '';
const message = [
  `Irish Visa Tracker workflow failed: ${workflow}`,
  `Conclusion: ${conclusion}`,
  event ? `Triggered by: ${event}` : '',
  branch ? `Branch: ${branch}` : '',
  runUrl ? `Run: ${runUrl}` : ''
].filter(Boolean).join('\n');

if (!process.env.ALERT_WEBHOOK_URL) {
  console.error('::error::ALERT_WEBHOOK_URL is not configured; this failure has no out-of-band alert.');
  console.error(message);
  process.exit(1);
}

try {
  await sendAlert(process.env.ALERT_WEBHOOK_URL, message);
  console.log(`Sent cron failure alert for ${workflow}.`);
} catch (error) {
  console.error(`::error::Could not send cron failure alert: ${String(error.message || error).slice(0, 300)}`);
  process.exit(1);
}
