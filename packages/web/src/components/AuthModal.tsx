import { useState } from 'react';
import Logo from './Logo';
import { login, register, type Session } from '../api';

export default function AuthModal({
  mode,
  onClose,
  onSuccess,
}: {
  mode: 'signup' | 'signin';
  onClose: () => void;
  onSuccess: (s: Session) => void;
}) {
  const [tab, setTab] = useState(mode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = tab === 'signup';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const s = signup ? await register(email, password) : await login(email, password);
      onSuccess(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        <div className="modal__brand"><Logo size={30} /></div>
        <h2 className="display modal__title">{signup ? 'Create your account' : 'Welcome back'}</h2>
        <p className="muted modal__sub">Bid live on stream, win the card, settle in USDC.</p>

        {error && <div className="auth__error">{error}</div>}

        <form onSubmit={submit} className="auth__form">
          <label className="auth__field">
            <span>Email</span>
            <input type="email" placeholder="name@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="auth__field">
            <span>Password</span>
            <input type="password" placeholder={signup ? 'At least 8 characters' : 'Your password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={signup ? 8 : undefined} required />
          </label>
          <button className="btn btn-primary btn-lg auth__submit" type="submit" disabled={busy}>
            {busy ? 'One sec…' : signup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth__switch">
          {signup ? 'Already have an account?' : 'New to BIDit?'}{' '}
          <button onClick={() => { setError(''); setTab(signup ? 'signin' : 'signup'); }}>
            {signup ? 'Sign in' : 'Create an account'}
          </button>
        </p>
        <p className="auth__legal">
          By continuing you agree to BIDit's <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
