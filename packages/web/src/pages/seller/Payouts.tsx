import { useSeller } from '../../components/SellerLayout';
import EmptyState from '../../components/EmptyState';
import { Wallet } from '../../icons';

export default function Payouts() {
  const { session } = useSeller();
  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Payouts</h1>
        <p className="muted">You’re paid in USDC. Funds release from escrow once the buyer’s order is delivered.</p>
      </div>

      <div className="bal-grid">
        <div className="bal card"><span className="muted">Available balance</span><b>${session.available}</b></div>
        <div className="bal card"><span className="muted">Pending in escrow</span><b>${session.settled}</b></div>
      </div>

      <div className="card acct-card split">
        <h3 className="acct-sub">How the split works</h3>
        <div className="split__bar">
          <span className="split__seller" style={{ width: '95%' }}>95% you</span>
          <span className="split__fee" style={{ width: '5%' }}>5%</span>
        </div>
        <p className="muted acct-note">On every shipped sale you keep <b>95%</b>. The remaining <b>5%</b> automatically buys back <b className="accent">$BID</b> on-chain — so every card that ships pumps the token.</p>
      </div>

      <h2 className="sl-sec">Statements</h2>
      <EmptyState icon={Wallet} title="No statements yet" sub="Your USDC payout history and exportable ledger will appear here after your first sale." />
    </>
  );
}
