import { useState } from 'react';
import Logo from './Logo';
import { login, register, forgotPassword, resetPassword, type Session } from '../api';
import { Check } from '../icons';

type Mode = 'signup' | 'signin' | 'forgot' | 'reset';

export default function AuthModal({
  mode,
  onClose,
  onSuccess,
}: {
  mode: 'signup' | 'signin';
  onClose: () => void;
  onSuccess: (s: Session) => void;
}) {
  const [tab, setTab] = useState<Mode>(mode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = tab === 'signup';

  const go = (next: Mode) => { setError(''); setNote(''); setTab(next); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (tab === 'forgot') {
        await forgotPassword(email);
        // Deliberately not "we found your account": the server answers the same
        // either way so nobody can use this to test which emails are registered.
        setNote('If that email has an account, a 6-digit code is on its way.');
        setTab('reset');
      } else if (tab === 'reset') {
        await resetPassword(email, code, password);
        setNote('Password updated. Sign in with your new one.');
        setCode('');
        setPassword('');
        setTab('signin');
      } else {
        onSuccess(signup ? await register(email, password) : await login(email, password));
        return; // modal closes on success
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const title =
    tab === 'forgot' ? 'Reset your password'
    : tab === 'reset' ? 'Enter your code'
    : signup ? 'Create your account'
    : 'Welcome back';

  const sub =
    tab === 'forgot' ? 'We’ll email you a code to set a new password.'
    : tab === 'reset' ? 'Check your inbox, then pick a new password.'
    : 'Bid live on stream, win the card, settle in USDC.';

  const action =
    busy ? 'One sec…'
    : tab === 'forgot' ? 'Send code'
    : tab === 'reset' ? 'Set new password'
    : signup ? 'Create account'
    : 'Sign in';

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="modal__brand"><Logo size={30} /></div>
        <h2 className="display modal__title">{title}</h2>
        <p className="muted modal__sub">{sub}</p>

        {error && <div className="auth__error">{error}</div>}
        {note && !error && <div className="dep-ok"><Check width={15} height={15} /> {note}</div>}

        <form onSubmit={submit} className="auth__form">
          <label className="auth__field">
            <span>Email</span>
            <input
              type="email"
              placeholder="name@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus={tab !== 'reset'}
              readOnly={tab === 'reset'}
            />
          </label>

          {tab === 'reset' && (
            <label className="auth__field">
              <span>6-digit code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                required
                autoFocus
              />
            </label>
          )}

          {tab !== 'forgot' && (
            <label className="auth__field">
              <span>{tab === 'reset' ? 'New password' : 'Password'}</span>
              <input
                type="password"
                placeholder={signup || tab === 'reset' ? 'At least 8 characters' : 'Your password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={signup || tab === 'reset' ? 8 : undefined}
                required
              />
            </label>
          )}

          {tab === 'signin' && (
            <button type="button" className="auth__forgot" onClick={() => go('forgot')}>
              Forgot your password?
            </button>
          )}

          <button className="btn btn-primary btn-lg auth__submit" type="submit" disabled={busy}>
            {action}
          </button>
        </form>

        {tab === 'forgot' || tab === 'reset' ? (
          <p className="auth__switch">
            <button onClick={() => go('signin')}>Back to sign in</button>
            {tab === 'reset' && <> · <button onClick={() => go('forgot')}>Send a new code</button></>}
          </p>
        ) : (
          <p className="auth__switch">
            {signup ? 'Already have an account?' : 'New to BIDit?'}{' '}
            <button onClick={() => go(signup ? 'signin' : 'signup')}>
              {signup ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        )}

        <p className="auth__legal">
          By continuing you agree to BIDit's <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
