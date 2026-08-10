import { useEffect, useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import { simulateDeposit, simulateSolDeposit, getSolRate, withdraw, refreshMe, money2, type SolRate } from '../../api';
import { Copy, Check, Wallet, Shield } from '../../icons';

export default function Deposit() {
  const { session, setSession } = useAccount();
  const [copied, setCopied] = useState(false);
  const addr = session.depositAddress ?? '…';
  const cluster = session.cluster ?? 'mock';
  const isReal = cluster === 'mainnet-beta' || cluster === 'devnet';
  const netLabel = cluster === 'mainnet-beta' ? 'Mainnet' : cluster === 'devnet' ? 'Devnet' : 'Devnet';

  // Which asset the user intends to send. Same address for both.
  const [asset, setAsset] = useState<'USDC' | 'SOL'>('USDC');
  const [solRate, setSolRate] = useState<SolRate | null>(null);
  useEffect(() => {
    getSolRate().then(setSolRate).catch(() => setSolRate(null));
  }, []);
  const solOn = solRate?.enabled !== false;

  const [depAmt, setDepAmt] = useState('25');
  const [depBusy, setDepBusy] = useState(false);
  const [depMsg, setDepMsg] = useState('');
  const [solAmt, setSolAmt] = useState('1');

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
      if (asset === 'SOL') {
        await simulateSolDeposit(solAmt);
        await refresh();
        setDepMsg(`Detected ${solAmt} SOL, converted and credited to your balance.`);
      } else {
        await simulateDeposit(depAmt);
        await refresh();
        setDepMsg(`Detected +$${depAmt} and credited it to your balance.`);
      }
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
        <p className="muted">Fund your balance with USDC. Cash out anytime.</p>
      </div>

      <div className="bal-grid bal-grid--one">
        <div className="bal card"><span className="muted">Wallet balance</span><b>${money2(session.settled)}</b></div>
      </div>
      <p className="muted acct-note" style={{ marginTop: -6, marginBottom: 18 }}>Your full balance. Placing a bid reserves funds, but they don’t leave your wallet. You’re only charged when you win.</p>

      <div className="card acct-card">
        <h3 className="acct-sub">Your deposit address <span className={`soon-tag${cluster === 'mainnet-beta' ? ' soon-tag--mainnet' : ''}`}>{netLabel}</span></h3>

        {solOn && (
          <div className="dep-asset" role="tablist" aria-label="Deposit asset">
            <button role="tab" aria-selected={asset === 'USDC'} className={`dep-asset__opt${asset === 'USDC' ? ' is-on' : ''}`} onClick={() => setAsset('USDC')}>
              USDC <span>1:1</span>
            </button>
            <button role="tab" aria-selected={asset === 'SOL'} className={`dep-asset__opt${asset === 'SOL' ? ' is-on' : ''}`} onClick={() => setAsset('SOL')}>
              SOL <span>auto-converts</span>
            </button>
          </div>
        )}

        {asset === 'USDC' ? (
          <p className="muted acct-note">
            Send <b>USDC (SPL)</b> on Solana {cluster === 'mainnet-beta' ? 'mainnet' : 'devnet'} to this address from any wallet (Phantom, Solflare) or straight from an exchange.
            It’s credited 1:1. You never need SOL for gas: BIDit covers the network fees.
          </p>
        ) : (
          <>
            <p className="muted acct-note">
              Send <b>SOL</b> on Solana {cluster === 'mainnet-beta' ? 'mainnet' : 'devnet'} to this same address. We convert it to USDC
              and credit your balance automatically. SOL is the easy one to buy with a card — grab it in Coinbase, Phantom, or any exchange, then send it here.
            </p>
            <div className="dep-rate">
              {solRate?.unavailable ? (
                <span className="muted">Live SOL rate is briefly unavailable. Your deposit is still credited at the rate when it lands.</span>
              ) : solRate?.creditPerSol ? (
                <>
                  <div className="dep-rate__row">
                    <span>Current rate</span>
                    <b>1 SOL ≈ ${solRate.usdPerSol}</b>
                  </div>
                  <div className="dep-rate__row">
                    <span>You’re credited</span>
                    <b>≈ ${solRate.creditPerSol} per SOL</b>
                  </div>
                  <p className="muted dep-rate__note">
                    Includes a {((solRate.spreadBps ?? 150) / 100).toFixed(2)}% conversion fee. You’re credited at the rate when your SOL <b>arrives</b> (usually within a minute), not right now, so the final amount can move a little with the market.
                  </p>
                </>
              ) : (
                <span className="muted">Loading live SOL rate…</span>
              )}
            </div>
          </>
        )}

        <div className="dep-usdc">
          <Shield width={16} height={16} />
          <span><b>USDC or SOL only.</b> This address takes USDC or SOL on Solana. Any other token, or a different network, may be lost for good.</span>
        </div>
        <div className="addr">
          <code>{addr}</code>
          <button className="addr__copy" onClick={copy}>{copied ? <Check width={16} height={16} /> : <Copy width={16} height={16} />}{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p className="muted acct-note dep-sweep">
          <b>What happens next.</b> Your deposit is detected on-chain, then swept into the BIDit treasury{asset === 'SOL' ? ' (SOL is converted to USDC)' : ''} and credited to
          your account balance, usually within a minute. This address is a one-way inbox, not a wallet to hold funds in: it is
          emptied every time something arrives. Your balance is held in USDC, and you can <b>withdraw it to any Solana address at any
          time</b> from the Withdraw section below.
        </p>

        {!isReal && (
          <div className="dep-sim">
            <span className="dep-sim__label">Devnet demo. Simulate an incoming {asset} deposit:</span>
            <div className="dep-sim__row">
              {asset === 'SOL' ? (
                <div className="dep-amt"><input type="number" min="0.01" step="0.5" value={solAmt} onChange={(e) => setSolAmt(e.target.value)} /><span style={{ paddingLeft: 6 }}>SOL</span></div>
              ) : (
                <div className="dep-amt"><span>$</span><input type="number" min="1" step="1" value={depAmt} onChange={(e) => setDepAmt(e.target.value)} /></div>
              )}
              <button className="btn btn-ghost btn-sm" onClick={doSimulate} disabled={depBusy}>{depBusy ? 'Detecting…' : 'Simulate deposit'}</button>
              {depMsg && <span className="acct-saved"><Check width={15} height={15} /> {depMsg}</span>}
            </div>
          </div>
        )}
      </div>

      {solOn && (
        <div className="card acct-card dep-card-guide">
          <h3 className="acct-sub">New to crypto? Fund with a card</h3>
          <p className="muted acct-note">The quickest way to bid if you’ve never held crypto — buy SOL with a debit/credit card, then send it to your address above. It lands as USDC in about a minute.</p>
          <ol className="dep-steps">
            <li><b>Get a wallet or exchange</b> that sells SOL with a card — <b>Coinbase</b>, <b>Phantom</b> (the “Buy” tab), or Kraken. In Canada, Shakepay and Newton take Interac e-transfer.</li>
            <li><b>Buy SOL</b> with your card for the amount you want to bid with.</li>
            <li><b>Send the SOL</b> to your BIDit deposit address above (copy it in).</li>
            <li><b>Bid.</b> Your USD balance appears here automatically, usually within a minute.</li>
          </ol>
          <p className="muted dep-steps__note">One-tap card checkout right here on BIDit is coming soon.</p>
        </div>
      )}

      <div className="card acct-card">
        <h3 className="acct-sub">Withdraw</h3>
        <p className="muted acct-note">Cash out any time. We send USDC from the treasury to any Solana address you name, and BIDit pays the network fee. Minimum withdrawal is $5. Funds reserved by active bids stay put until those auctions end.</p>
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
