/**
 * Transactional email via Amazon SES. A thin seam: with AWS credentials set it
 * sends real mail; without them, it no-ops (logs) so every other environment:
 * tests, local, a friend's box without the keys: works unchanged. Never throws.
 */
import { sesConfigured, sendViaSes } from './ses.js';
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /**
   * True for mail whose SUBJECT carries a secret. Verification and reset codes
   * live in the subject line ("482913 is your BIDit password reset code"), so
   * logging it verbatim handed anyone with log access a working takeover: request
   * a reset for any address, read the code out of the log. Sensitive mail logs a
   * category instead, and the code never leaves the HMAC in the database.
   */
  sensitive?: boolean;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Email subjects are single-line. Strip CR/LF + control chars and clamp length so
 *  seller-controlled text (a listing title / carrier / tracking #) that flows into a
 *  subject can't inject headers or bloat it. Applied at the one send choke point. */
export const cleanSubject = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Minimal branded HTML shell around a message body. */
export function emailShell(heading: string, bodyHtml: string, ctaHref?: string): string {
  const cta = ctaHref
    ? `<a href="${ctaHref}" style="display:inline-block;margin-top:16px;background:#111827;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:600">Open BIDit</a>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">
    <div style="font-size:20px;font-weight:800;letter-spacing:-.02em">BID<span style="color:#6d28d9">it</span></div>
    <h1 style="font-size:19px;margin:18px 0 8px">${escapeHtml(heading)}</h1>
    <div style="font-size:14px;line-height:1.55;color:#374151">${bodyHtml}</div>
    ${cta}
    <p style="margin-top:24px;font-size:12px;color:#9ca3af">Live trading-card auctions on Pump.fun.</p>
  </div>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 8px">${escapeHtml(text)}</p>`;
}

/** Is real delivery configured? Used by the startup banner and /health so an
 *  operator can tell at a glance whether codes are being mailed or only logged. */
export const emailEnabled = (): boolean => sesConfigured();

/** The From address in force. Exposed for the startup banner: a wrong or
 *  unverified From is the single most common reason nothing arrives. The
 *  address (or its domain) must be a verified identity in SES. */
export const emailFrom = (): string =>
  process.env.BIDIT_EMAIL_FROM ?? 'BIDit <no-reply@biditsol.com>';

export interface SendResult {
  ok: boolean;
  /** Why it failed, safe to show an admin. Never contains the API key. */
  error?: string;
}

/**
 * Send one transactional email. Never throws: a failed verification mail must
 * not fail the signup that triggered it, but it now REPORTS the outcome so
 * callers (and the admin test endpoint) can surface it. Silent failure here
 * used to be indistinguishable from success, which made a misconfigured domain
 * impossible to diagnose from outside the server logs.
 */
export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const from = emailFrom();
  const subject = cleanSubject(msg.subject);
  // Never let a code reach the logs. See EmailMessage.sensitive.
  const logSubject = msg.sensitive ? '(redacted: one-time code)' : JSON.stringify(subject);
  if (!sesConfigured()) {
    console.log(`[email:noop] to=${msg.to} subject=${logSubject} (set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to send)`);
    return { ok: false, error: 'AWS SES credentials are not set, so nothing was sent.' };
  }
  const result = await sendViaSes({ from, to: msg.to, subject, html: msg.html });
  if (!result.ok) {
    // SES's body says exactly what's wrong (unverified identity, sandbox
    // recipient restriction, wrong region). Log it verbatim: it's the whole answer.
    console.error(`[email] send FAILED from=${from} to=${msg.to} :: ${result.error}`);
    return result;
  }
  console.log(`[email] sent to=${msg.to} from=${from} subject=${logSubject}`);
  return result;
}
