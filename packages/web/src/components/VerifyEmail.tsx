import { useEffect, useRef, useState } from 'react';
import Logo from './Logo';
import { verifyEmail, resendVerifyCode, logout, clearToken, type Session } from '../api';
import { Check } from '../icons';

const RESEND_SECONDS = 60;

/**
 * Blocking step shown right after signup: the account exists but stays
 * unverified until the emailed code comes back. Deliberately has no skip —
 * bidding, buying, withdrawing and selling are all gated on this server-side,
 * so letting someone past would only produce confusing failures later.
 *
 * "Use a different email" is a sign-out, not an edit: changing the address on
 * an unverified account is exactly the flow an attacker would want.
 */
export default function VerifyEmail({ session, onVerified }: { session: Session; onVerified: (s: Session) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const [resent, setResent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // The server enforces the real cooldown; this just stops the button looking
  // available while it would still be refused.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const submit = async (value: string) => {
    setBusy(true);
    setError('');
    try {
      onVerified(await verifyEmail(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
      setCode('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    setError('');
    if (digits.length === 6) void submit(digits); // no "submit" tap needed
  };

  const resend = async () => {
    setError('');
    setResent(false);
    try {
      await resendVerifyCode();
      setResent(true);
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send another code.');
    }
  };

  return (
    <div className="ob__scrim">
      <div className="ob vfy">
        <div className="ob__top"><Logo size={26} /></div>
        <h1 className="display ob__title">Confirm your email</h1>
        <p className="muted vfy__sub">
          We sent a 6-digit code to <b>{session.email}</b>. Enter it to finish setting up your account.
        </p>

        <input
          ref={inputRef}
          className="vfy__code"
          value={code}
          onChange={(e) => onChange(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="6-digit verification code"
          disabled={busy}
        />

        {error && <div className="auth__error">{error}</div>}
        {resent && !error && <div className="vfy__ok"><Check width={15} height={15} /> New code sent.</div>}

        <div className="vfy__actions">
          <button className="btn btn-primary btn-lg" onClick={() => void submit(code)} disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Verify email'}
          </button>
          <button className="vfy__resend" onClick={() => void resend()} disabled={cooldown > 0}>
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
          </button>
        </div>

        <p className="muted vfy__foot">
          Wrong address, or no email after a few minutes? Check spam, or{' '}
          <button
            className="vfy__link"
            onClick={() => { void logout(); clearToken(); location.reload(); }}
          >
            sign out and start over
          </button>
          .
        </p>
      </div>
    </div>
  );
}
