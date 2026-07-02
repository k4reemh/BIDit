import { useAccount } from '../../components/AccountLayout';
import EmptyState from '../../components/EmptyState';
import { Bolt } from '../../icons';

export default function Bids() {
  useAccount();
  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Bids &amp; offers</h1>
        <p className="muted">Auctions you’re in right now, and the ones you’re leading.</p>
      </div>
      <EmptyState
        icon={Bolt}
        title="No active bids"
        sub="Jump into a live auction and your bids will appear here in real time."
        ctaText="Browse live auctions"
        ctaTo="/"
      />
    </>
  );
}
