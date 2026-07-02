import { useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import { simulateDeposit, withdraw, refreshMe } from '../../api';
import { Copy, Check, Wallet } from '../../icons';

export default function Deposit() {
  const { session, setSession } = useAccount();
  const [copied, setCopied] = useState(false);
  const addr = session.depositAddress ?? '—';
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
      setDepMsg(`Detected +$${depAmt} — credited to your balance.`);
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
      setWOk(`Withdrawal ${r.status.toLowerCase()}${r.txSig ? ` · ${r.txSig.slice(0, 10)}…` : ''}`);
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
        <p className="muted">Fund your balance with USDC or SOL, and cash out anytime.</p>
      </div>

      <div className="bal-grid bal-grid--one">
        <div className="bal card"><span className="muted">Wallet balance</span><b>${session.settled}</b></div>
      </div>
      <p className="muted acct-note" style={{ marginTop: -6, marginBottom: 18 }}>Your full balance. Placing a bid reserves funds but doesn’t leave your wallet — you’re only charged when you win.</p>

      <div className="card acct-card">
        <h3 className="acct-sub">Your deposit wallet <span className={`soon-tag${cluster === 'mainnet-beta' ? ' soon-tag--mainnet' : ''}`}>{netLabel}</span></h3>
        <p className="muted acct-note">
          Send <b>USDC (SPL)</b> on Solana {cluster === 'mainnet-beta' ? 'mainnet' : 'devnet'} to this address from any wallet (Phantom, etc.).
          It’s detected on-chain and credited to your balance automatically once it confirms.
          {cluster === 'mainnet-beta' && <> Send only USDC — anything else may be lost.</>}
        </p>
        <div className="addr">
          <code>{addr}</code>
          <button className="addr__copy" onClick={copy}>{copied ? <Check width={16} height={16} /> : <Copy width={16} height={16} />}{copied ? 'Copied' : 'Copy'}</button>
        </div>

        {!isReal && (
          <div className="dep-sim">
            <span className="dep-sim__label">Devnet demo — simulate an incoming deposit:</span>
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
        {wErr && <div className="auth__error">{wErr}</div>}
        {wOk && <div className="dep-ok"><Check width={15} height={15} /> {wOk}</div>}
        <div className="fld-row">
          <div className="fld"><label>Amount (USDC)</label><input type="number" min="0" step="0.01" value={wAmt} onChange={(e) => setWAmt(e.target.value)} placeholder="0.00" /></div>
          <div className="fld"><label>Destination address</label><input value={wTo} onChange={(e) => setWTo(e.target.value)} placeholder="Solana address" /></div>
        </div>
        <div className="acct-actions">
          <button className="btn btn-primary" onClick={doWithdraw} disabled={wBusy || !wAmt || !wTo.trim()}>{wBusy ? 'Sending…' : 'Withdraw'}</button>
          <span className="muted" style={{ fontSize: 13 }}>Wallet: ${session.settled}</span>
        </div>
      </div>

      <div className="card acct-card deposit-soon">
        <span className="deposit-soon__ic"><Wallet width={24} height={24} /></span>
        <div>
          <h3 className="acct-sub" style={{ marginBottom: 4 }}>One-click wallet deposit</h3>
          <p className="muted">Connect Phantom and top up in a tap — coming soon.</p>
        </div>
        <button className="btn btn-ghost" disabled>Connect wallet · soon</button>
      </div>
    </>
  );
}
