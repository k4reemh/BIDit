/**
 * Transactional email via Resend. A thin seam: with RESEND_API_KEY set it sends
 * real mail; without it, it no-ops (logs) so every other environment — tests,
 * local, a friend's box without the key — works unchanged. Never throws.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

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

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BIDIT_EMAIL_FROM ?? 'BIDit <onboarding@resend.dev>';
  if (!key) {
    console.log(`[email:noop] to=${msg.to} subject=${JSON.stringify(msg.subject)} (set RESEND_API_KEY to send)`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: msg.to, subject: msg.subject, html: msg.html }),
    });
    if (!res.ok) console.error('[email] send failed', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[email] error', (err as Error)?.message ?? err);
  }
}
