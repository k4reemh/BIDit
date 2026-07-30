/**
 * Transactional email via Resend. A thin seam: with RESEND_API_KEY set it sends
 * real mail; without it, it no-ops (logs) so every other environment: tests,
 * local, a friend's box without the key: works unchanged. Never throws.
 */
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
export const emailEnabled = (): boolean => !!process.env.RESEND_API_KEY;

/** The From address in force. Exposed for the startup banner: a wrong or
 *  unverified From is the single most common reason nothing arrives. */
export const emailFrom = (): string =>
  process.env.BIDIT_EMAIL_FROM ?? 'BIDit <onboarding@resend.dev>';

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
  const key = process.env.RESEND_API_KEY;
  const from = emailFrom();
  const subject = cleanSubject(msg.subject);
  // Never let a code reach the logs. See EmailMessage.sensitive.
  const logSubject = msg.sensitive ? '(redacted: one-time code)' : JSON.stringify(subject);
  if (!key) {
    console.log(`[email:noop] to=${msg.to} subject=${logSubject} (set RESEND_API_KEY to send)`);
    return { ok: false, error: 'RESEND_API_KEY is not set, so nothing was sent.' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: msg.to, subject, html: msg.html }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      // Resend's body says exactly what's wrong (unverified domain, bad From,
      // sandbox-recipient restriction). Log it verbatim: it's the whole answer.
      console.error(`[email] send FAILED ${res.status} from=${from} to=${msg.to} :: ${body}`);
      return { ok: false, error: `Resend responded ${res.status}: ${body || '(empty body)'}` };
    }
    console.log(`[email] sent to=${msg.to} from=${from} subject=${logSubject}`);
    return { ok: true };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    console.error('[email] network error', error);
    return { ok: false, error };
  }
}
