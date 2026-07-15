import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPoints, claimMission, type PointsSummary, type Mission, type Session } from '../api';
import {
  Gift, Bolt, Wallet, Tag, UserCheck, Users, Dice, Check, ArrowRight, Bag,
} from '../icons';

const fmt = (n: number) => n.toLocaleString('en-US');

const MISSION_ICONS: Record<string, typeof Gift> = {
  deposit: Wallet,
  first_bid: Bolt,
  first_win: Tag,
  giveaway_win: Dice,
  refer_friend: Users,
  first_sale: Bag,
  sell_10: Bag,
  verified_seller: UserCheck,
};

export default function Points({ session, onAuth }: { session: Session | null; onAuth: () => void }) {
  const [data, setData] = useState<PointsSummary | null>(null);
  const [busy, setBusy] = useState('');
  const [justClaimed, setJustClaimed] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session) return;
    getPoints().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  }, [session]);

  const claim = async (m: Mission) => {
    setBusy(m.id);
    setError('');
    try {
      await claimMission(m.id);
      setJustClaimed(m.id);
      setTimeout(() => setJustClaimed(''), 1600);
      setData(await getPoints());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not claim.');
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="container pts">
      {/* hero */}
      <section className="pts__hero card">
        <div className="pts__hero-glow" aria-hidden />
        <div className="pts__hero-main">
          <span className="pts__eyebrow"><Gift width={15} height={15} /> BIDit Points</span>
          <h1 className="display pts__title">Use BIDit. Earn points.<br />Catch the airdrops.</h1>
          <p className="pts__sub">
            Every dollar you spend earns <b className="accent">100 points</b> — win a $10 auction, pocket 1,000 points.
            Sellers earn <b className="accent">20 points per $1 sold</b>, so $1,000 sold on stream is 20,000 points.
            Points decide your share of the <b>$BID community airdrops</b>: 5% of supply is locked for holders of these
            points, with the first drop one month after launch.
          </p>
          <div className="pts__rates">
            <div className="pts__rate">
              <span className="pts__rate-x">100×</span>
              <div><b>Buyers</b><span>points on every $1 spent</span></div>
            </div>
            <div className="pts__rate">
              <span className="pts__rate-x">20×</span>
              <div><b>Sellers</b><span>points on every $1 sold</span></div>
            </div>
            <div className="pts__rate">
              <span className="pts__rate-x">5%</span>
              <div><b>of $BID supply</b><span>locked for community airdrops</span></div>
            </div>
          </div>
        </div>
        <div className="pts__balance">
          <span className="pts__balance-label">Your points</span>
          {session ? (
            <>
              <b className="pts__balance-num">{data ? fmt(data.points) : '—'}</b>
              <Link to="/leaderboard" className="pts__balance-link">View leaderboard <ArrowRight width={14} height={14} /></Link>
            </>
          ) : (
            <>
              <b className="pts__balance-num">0</b>
              <button className="btn btn-primary" onClick={onAuth}>Sign up & start earning</button>
            </>
          )}
        </div>
      </section>

      {/* missions */}
      <section className="pts__missions">
        <div className="section__head">
          <div>
            <h2 className="section-title">Point bonuses</h2>
            <div className="section-sub">One-time missions. Do the thing, then hit claim — points land instantly.</div>
          </div>
        </div>
        {error && <div className="auth__error" style={{ marginBottom: 14 }}>{error}</div>}

        <div className="pts__grid">
          {(data?.missions ?? PLACEHOLDER).map((m) => {
            const Icon = MISSION_ICONS[m.id] ?? Gift;
            const claimable = m.status === 'claimable';
            const claimed = m.status === 'claimed';
            return (
              <div key={m.id} className={`pts__mission card${claimable ? ' is-claimable' : ''}${claimed ? ' is-claimed' : ''}`}>
                <div className="pts__mission-top">
                  <span className="pts__mission-ic"><Icon width={20} height={20} /></span>
                  <span className="pts__mission-pts">+{fmt(m.points)} pts</span>
                </div>
                <b className="pts__mission-title">{m.title}</b>
                <span className="pts__mission-desc">{m.desc}</span>
                {claimed ? (
                  <span className="pts__claimed"><Check width={15} height={15} /> Claimed</span>
                ) : m.comingSoon ? (
                  <span className="pts__soon">Coming soon</span>
                ) : (
                  <button
                    className={`btn pts__claim${claimable ? ' btn-primary' : ''}${justClaimed === m.id ? ' just' : ''}`}
                    disabled={!claimable || !session || busy === m.id}
                    onClick={() => claim(m)}
                  >
                    {busy === m.id ? 'Claiming…' : justClaimed === m.id ? `+${fmt(m.points)}!` : 'Claim'}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="pts__foot muted">
          Airdrop one lands <b>1 month after launch</b>; the next follows <b>3 months after launch</b>. Points are a
          loyalty score for community airdrops and prizes — not a currency, deposit or investment.
          {' '}<Link to="/docs#points">Read the full breakdown in Docs</Link>.
        </div>
      </section>
    </main>
  );
}

/* Signed-out skeleton: real mission list with everything locked. */
const PLACEHOLDER: Mission[] = [
  { id: 'deposit', title: 'Fund your wallet', desc: 'Deposit USDC into your BIDit wallet.', points: 1000, status: 'locked', comingSoon: false },
  { id: 'first_bid', title: 'Place your first bid', desc: 'Jump into any live auction and bid.', points: 1000, status: 'locked', comingSoon: false },
  { id: 'first_win', title: 'Win your first auction', desc: 'Outbid the room and take an item home.', points: 3000, status: 'locked', comingSoon: false },
  { id: 'giveaway_win', title: 'Win a live giveaway', desc: 'Get drawn as the winner of a stream giveaway.', points: 1000, status: 'locked', comingSoon: false },
  { id: 'refer_friend', title: 'Refer a friend', desc: 'They sign up and purchase an item.', points: 5000, status: 'locked', comingSoon: true },
  { id: 'first_sale', title: 'Make your first sale', desc: 'Sell and fulfill your first item on BIDit.', points: 3000, status: 'locked', comingSoon: false },
  { id: 'sell_10', title: 'Fulfill 10 orders', desc: 'Sell and fulfill 10 items on BIDit.', points: 3000, status: 'locked', comingSoon: false },
  { id: 'verified_seller', title: 'Become a Verified Seller', desc: 'Sell and fulfill $500 worth of items.', points: 10000, status: 'locked', comingSoon: false },
];
