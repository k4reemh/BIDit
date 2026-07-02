import { useAccount } from '../../components/AccountLayout';
import EmptyState from '../../components/EmptyState';
import { Bag } from '../../icons';

const STAGES = ['Won', 'Paid (escrow)', 'Shipped', 'Delivered'];

export default function Purchases() {
  useAccount();
  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Purchases</h1>
        <p className="muted">Everything you win, from the buzzer to your doorstep.</p>
      </div>
      <div className="track card">
        {STAGES.map((s, i) => (
          <div className="track__step" key={s}>
            <span className="track__n">{i + 1}</span>
            <span>{s}</span>
            {i < STAGES.length - 1 && <span className="track__line" />}
          </div>
        ))}
      </div>
      <EmptyState
        icon={Bag}
        title="No purchases yet"
        sub="Win an auction and it’ll show up here — we’ll track it all the way to delivered."
        ctaText="Find something to win"
        ctaTo="/"
      />
    </>
  );
}
