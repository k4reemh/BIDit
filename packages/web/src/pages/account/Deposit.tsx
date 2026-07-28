import { useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import { simulateDeposit, withdraw, refreshMe, money2, exportWalletKey } from '../../api';
import { Copy, Check, Wallet, Shield } from '../../icons';

export default function Deposit() {
  const { session, setSession } = useAccount();
  const [copied, setCopied] = useState(false);
  const addr = session.depositAddress ?? '…';
  const cluster = session.cluster ?? 'mock';
  const isReal = cluster === 'mainnet-beta' || cluster === 'devnet';
  const netLabel = cluster === 'mainnet-beta' ? 'Mainnet' : cluster === 'devnet' ? 'Devnet' : 'Devnet';

  const [depAmt, setDepAmt] = useState('25');
  const [depBusy, setDepBusy] = useState(false);
  const [depMsg, setDepMsg] = useState('');

  const [wAmt, setWAmt] = useState('');
  const [wTo, setWTo] = useState('');
  const [wBusy, setWBusy] = useState(false);
  const [wErr, setWErr] = useState('');
  const [wOk, setWOk] = useState('');

  // Private-key export. Held in component state only for as long as the card is
  // open — never written to storage, and cleared when they hide it again.
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyPw, setKeyPw] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyErr, setKeyErr] = useState('');
  const [secret, setSecret] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);

  const revealKey = async () => {
    setKeyBusy(true);
    setKeyErr('');
    try {
      const r = await exportWalletKey(keyPw);
      setSecret(r.secretKeyBase58);
      setKeyPw('');
    } catch (err) {
      setKeyErr(err instanceof Error ? err.message : 'Could not export the key.');
    } finally {
      setKeyBusy(false);
    }
  };

  const hideKey = () => {
    setSecret('');
    setKeyPw('');
    setKeyErr('');
    setKeyOpen(false);
  };

  const refresh = async () => setSession(await refreshMe());

  const copy = () =>
    navigator.clipboard?.writeText(addr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });

  const doSimulate = async () => {
    setDepBusy(true);
    setDepMsg('');
    try {
      await simulateDeposit(depAmt);
      await refresh();
      setDepMsg(`Detected +$${depAmt} and credited it to your balance.`);
      setTimeout(() => setDepMsg(''), 3500);
    } finally {
      setDepBusy(false);
    }
  };

  const doWithdraw = async () => {
    setWBusy(true);
    setWErr('');
    setWOk('');
    try {
      const r = await withdraw(wAmt, wTo.trim());
      await refresh();
      const label = r.status === 'SUBMITTED' ? 'sent, confirming on-chain' : r.status.toLowerCase();
      setWOk(`Withdrawal ${label}${r.txSig ? ` · ${r.txSig.slice(0, 10)}…` : ''}`);
      setWAmt('');
      setTimeout(() => setWOk(''), 4000);
    } catch (err) {
      setWErr(err instanceof Error ? err.message : 'Withdrawal failed.');
    } finally {
      setWBusy(false);
    }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Deposit &amp; withdraw</h1>
        <p className="muted">Fund your balance with USDC or SOL. Cash out anytime.</p>
      </div>

      <div className="bal-grid bal-grid--one">
        <div className="bal card"><span className="muted">Wallet balance</span><b>${money2(session.settled)}</b></div>
      </div>
      <p className="muted acct-note" style={{ marginTop: -6, marginBottom: 18 }}>Your full balance. Placing a bid reserves funds, but they don’t leave your wallet. You’re only charged when you win.</p>

      <div className="card acct-card">
        <h3 className="acct-sub">Your deposit wallet <span className={`soon-tag${cluster === 'mainnet-beta' ? ' soon-tag--mainnet' : ''}`}>{netLabel}</span></h3>
        <p className="muted acct-note">
          Send <b>USDC (SPL)</b> on Solana {cluster === 'mainnet-beta' ? 'mainnet' : 'devnet'} to this address from any wallet (Phantom, etc.).
          We detect it on-chain and credit your balance automatically once it confirms.
          {cluster === 'mainnet-beta' && <> Send only USDC. Anything else may be lost.</>}
        </p>
        <div className="addr">
          <code>{addr}</code>
          <button className="addr__copy" onClick={copy}>{copied ? <Check width={16} height={16} /> : <Copy width={16} height={16} />}{copied ? 'Copied' : 'Copy'}</button>
        </div>

        {!isReal && (
          <div className="dep-sim">
            <span className="dep-sim__label">Devnet demo. Simulate an incoming deposit:</span>
            <div className="dep-sim__row">
              <div className="dep-amt"><span>$</span><input type="number" min="1" step="1" value={depAmt} onChange={(e) => setDepAmt(e.target.value)} /></div>
              <button className="btn btn-ghost btn-sm" onClick={doSimulate} disabled={depBusy}>{depBusy ? 'Detecting…' : 'Simulate deposit'}</button>
              {depMsg && <span className="acct-saved"><Check width={15} height={15} /> {depMsg}</span>}
            </div>
          </div>
        )}
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Withdraw</h3>
        <p className="muted acct-note">Send USDC from your wallet to any Solana address. Funds reserved by active bids stay put until those auctions end.</p>
        <div className="beta-cap">
          <Shield width={16} height={16} />
          <span><b>Beta safety limit:</b> withdrawals are capped at <b>$1,000 per day</b> per account while we harden the payout system during BIDit beta. It’s temporary and will be lifted.</span>
        </div>
        {wErr && <div className="auth__error">{wErr}</div>}
        {wOk && <div className="dep-ok"><Check width={15} height={15} /> {wOk}</div>}
        <div className="fld-row">
          <div className="fld"><label>Amount (USDC)</label><input type="number" min="0" step="0.01" value={wAmt} onChange={(e) => setWAmt(e.target.value)} placeholder="0.00" /></div>
          <div className="fld"><label>Destination address</label><input value={wTo} onChange={(e) => setWTo(e.target.value)} placeholder="Solana address" /></div>
        </div>
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={doWithdraw} disabled={wBusy || !wAmt || !wTo.trim()}>{wBusy ? 'Sending…' : 'Withdraw'}</button>
          <span className="muted" style={{ fontSize: 13 }}>Wallet: ${money2(session.settled)}</span>
        </div>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Export your wallet key</h3>
        <p className="muted acct-note">
          Your deposit address is a real Solana wallet. Export its private key to import the same
          wallet into Phantom or Solflare.
        </p>
        <div className="keyx__warn">
          <Shield width={16} height={16} />
          <span>
            <b>Anyone with this key controls that wallet.</b> Never share it or paste it into a site
            that asks for it. BIDit will never ask you for it. Note that USDC sent to this address is
            still swept into your BIDit balance automatically, so don’t use it as a personal wallet.
          </span>
        </div>
        {!keyOpen ? (
          <div className="acct-actions">
            <button className="btn btn-ghost" onClick={() => setKeyOpen(true)}>Export private key</button>
          </div>
        ) : secret ? (
          <>
            <div className="fld">
              <label>Private key (base58)</label>
              <code className="keyx__secret">{secret}</code>
            </div>
            <div className="acct-actions">
              <button
                className="btn btn-primary"
                onClick={() =>
                  navigator.clipboard?.writeText(secret).then(() => {
                    setKeyCopied(true);
                    setTimeout(() => setKeyCopied(false), 1800);
                  })
                }
              >
                {keyCopied ? 'Copied' : 'Copy key'}
              </button>
              <button className="btn btn-ghost" onClick={hideKey}>Hide</button>
            </div>
          </>
        ) : (
          <>
            {keyErr && <div className="auth__error">{keyErr}</div>}
            <div className="fld">
              <label>Confirm your password</label>
              <input
                type="password"
                value={keyPw}
                onChange={(e) => setKeyPw(e.target.value)}
                placeholder="Your BIDit password"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && keyPw) void revealKey(); }}
              />
            </div>
            <div className="acct-actions">
              <button className="btn btn-primary" onClick={() => void revealKey()} disabled={keyBusy || !keyPw}>
                {keyBusy ? 'Checking…' : 'Reveal key'}
              </button>
              <button className="btn btn-ghost" onClick={hideKey}>Cancel</button>
            </div>
          </>
        )}
      </div>

      <div className="card acct-card deposit-soon">
        <span className="deposit-soon__ic"><Wallet width={24} height={24} /></span>
        <div>
          <h3 className="acct-sub" style={{ marginBottom: 4 }}>One-click wallet deposit</h3>
          <p className="muted">Connect Phantom and top up in a tap. Coming soon.</p>
        </div>
        <button className="btn btn-ghost" disabled>Connect wallet · soon</button>
      </div>
    </>
  );
}
