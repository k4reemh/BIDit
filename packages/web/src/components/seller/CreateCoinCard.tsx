import { useEffect, useRef, useState } from 'react';
import {
  prepareCoinCreate,
  submitCoinCreate,
  getCoinCreateStatus,
  refreshMe,
  ApiError,
  type Session,
} from '../../api';
import { hasPhantom, connectPhantom, signCreateTx, signLoginMessage, PhantomError } from '../../lib/phantom';
import { Bolt, Check } from '../../icons';

type Stage = 'idle' | 'working' | 'done';

/**
 * "Create my livestream coin" — one click creates "<handle>'s BIDit Livestream"
 * on pump.fun under the SELLER's own pump.fun account (that's what makes
 * pump.fun show THEM the Start-livestream button) and auto-links it as their
 * saved coin.
 *
 * The seller signs pump.fun's sign-in message — a plain text signature, so it
 * costs nothing, moves nothing, and raises none of the wallet's scary
 * transaction warnings. If pump.fun won't play along we say so plainly and
 * point at the manual route; we never quietly fall back to a path that charges
 * a fee. In mock/dev mode the whole flow runs with no wallet at all.
 * Mounted in seller onboarding (step 2) and in Settings while no coin is linked.
 */
export default function CreateCoinCard({
  session,
  setSession,
  onLinked,
}: {
  session: Session;
  setSession: (s: Session) => void;
  onLinked?: (mint: string) => void;
}) {
  const [stage, setStage] = useState<Stage>('idle');
  const [step, setStep] = useState(''); // human-visible progress line while working
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false); // show the "do it yourself" route
  const [mint, setMint] = useState('');
  const [imgOk, setImgOk] = useState(true);
  const alive = useRef(true);
  const retriedExpiry = useRef(false);
  const mockMode = (session.cluster ?? 'mock') !== 'mainnet-beta';

  useEffect(() => {
    alive.current = true;
    // Resume a flow this tab (or a closed one) left mid-air: the status call
    // also lazily reconciles a SUBMITTED attempt against the chain.
    getCoinCreateStatus()
      .then((s) => {
        if (!alive.current) return;
        if (s.status === 'CONFIRMED' && s.mint && s.linkedCoin === s.mint) {
          setMint(s.mint);
          setStage('done');
        } else if (s.status === 'SUBMITTED') {
          setStage('working');
          setStep('Waiting for the network to confirm…');
          void pollUntilSettled();
        }
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishLinked = async (m: string) => {
    setMint(m);
    setStage('done');
    try {
      const s = await refreshMe();
      if (alive.current) setSession(s);
    } catch {
      /* session poll will catch up */
    }
    onLinked?.(m);
  };

  const pollUntilSettled = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!alive.current) return;
      try {
        const s = await getCoinCreateStatus();
        if (s.status === 'CONFIRMED' && s.mint) return void finishLinked(s.mint);
        if (s.status === 'FAILED') {
          setStage('idle');
          setError(s.error || 'That didn’t go through — nothing was charged. Try again.');
          return;
        }
      } catch {
        /* transient; keep polling */
      }
    }
    setStage('idle');
    setError('Still working on it — check back in a minute.');
  };

  const create = async () => {
    setError('');
    setManual(false);
    setStage('working');
    try {
      if (mockMode) {
        setStep('Creating your coin…');
        const prep = await prepareCoinCreate();
        const result = await submitCoinCreate({ attemptId: prep.attemptId });
        if (result.status === 'CONFIRMED' && result.mint) return void finishLinked(result.mint);
        setStep('Waiting for the network to confirm…');
        return void pollUntilSettled();
      }

      setStep('Connecting to Phantom…');
      const wallet = await connectPhantom();
      setStep('Preparing your coin…');
      const prep = await prepareCoinCreate(wallet);

      if (prep.signMode === 'message' && prep.loginMessage) {
        setStep('Approve the pump.fun sign-in in Phantom — it’s just a signature: no fee, nothing spent.');
        const loginSignature = await signLoginMessage(prep.loginMessage);
        setStep('Creating your coin on pump.fun…');
        const result = await submitCoinCreate({ attemptId: prep.attemptId, publicKey: wallet, loginSignature });
        if (result.status === 'CONFIRMED' && result.mint) return void finishLinked(result.mint);
        setStep('Finishing up…');
        return void pollUntilSettled();
      }

      if (prep.signMode !== 'transaction' || !prep.txB64) {
        const result = await submitCoinCreate({ attemptId: prep.attemptId });
        if (result.status === 'CONFIRMED' && result.mint) return void finishLinked(result.mint);
        return void pollUntilSettled();
      }
      setStep('Approve the request in Phantom — it costs $0 (dust network fees only).');
      const signedTxB64 = await signCreateTx(prep.txB64);
      setStep('Creating your coin on pump.fun…');
      const result = await submitCoinCreate({ attemptId: prep.attemptId, signedTxB64 });
      if (result.status === 'CONFIRMED' && result.mint) return void finishLinked(result.mint);
      setStep('Waiting for the network to confirm…');
      return void pollUntilSettled();
    } catch (err) {
      if (!alive.current) return;
      // A signature that sat too long: quietly build a fresh one, once.
      if (err instanceof ApiError && err.code === 'TX_EXPIRED' && !retriedExpiry.current) {
        retriedExpiry.current = true;
        return void create();
      }
      setStage('idle');
      if (err instanceof PhantomError) {
        setError(
          err.code === 'NOT_INSTALLED'
            ? 'Phantom isn’t installed. Get it at phantom.app, or paste an existing coin below.'
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
        // pump.fun refused or was unreachable. There is no cheaper automatic
        // route, so point at the manual one instead of pretending otherwise.
        setManual(err instanceof ApiError && (err.code === 'CREATE_FAILED' || err.code === 'PROVIDER_UNAVAILABLE'));
      }
    }
  };

  if (stage === 'done') {
    return (
      <div className="ccc card ccc--done">
        <div className="dep-ok"><Check width={15} height={15} /> Your livestream coin is live and linked.</div>
        <div className="ccc__mint">
          <code>{mint}</code>
          <a className="btn btn-ghost btn-sm" href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
            View on pump.fun ↗
          </a>
        </div>
        <p className="muted ccc__note">
          To go live: open your coin on pump.fun{mockMode ? '' : ' with the wallet you just signed with'} and hit{' '}
          <b>Start livestream</b>. Your stream and auctions appear on BIDit automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="ccc card">
      <div className="ccc__head">
        {imgOk ? (
          <img className="ccc__img" src="/pump-coin.png" alt="" onError={() => setImgOk(false)} />
        ) : (
          <span className="ccc__img ccc__img--ph"><Bolt width={22} height={22} /></span>
        )}
        <div>
          <b className="ccc__name">{session.handle}&rsquo;s BIDit Livestream</b>
          <p className="muted ccc__sub">
            We create this coin on pump.fun for you — completely free. You’ll just sign pump.fun’s sign-in
            message in your wallet (a signature, not a payment — nothing can be spent). The coin is created
            under <i>your</i> pump.fun account, so you get the Start-livestream button, and it’s saved as your
            linked coin here.
          </p>
        </div>
      </div>

      {error && <div className="auth__error">{error}</div>}
      {manual && (
        <p className="muted ccc__note">
          You can also make it yourself: create a coin at{' '}
          <a href="https://pump.fun/create" target="_blank" rel="noreferrer">
            pump.fun/create
          </a>{' '}
          (a $0 buy costs nothing), then paste its address in Settings to link it.
        </p>
      )}

      {stage === 'working' ? (
        <div className="ccc__busy"><span className="spinner" /> {step}</div>
      ) : (
        <button className="btn btn-primary" onClick={create}>
          {mockMode || hasPhantom() ? 'Create my livestream coin' : 'Install Phantom to create'}
        </button>
      )}
    </div>
  );
}
