import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '../components/Avatar';
import { getLeaderboard, type LeaderboardRow } from '../api';
import { Gift, ArrowRight } from '../icons';

const fmt = (n: number) => n.toLocaleString('en-US');
const MEDALS = ['🥇', '🥈', '🥉'];

export default function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getLeaderboard().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
  }, []);

  const podium = rows?.slice(0, 3) ?? [];
  const rest = rows?.slice(3) ?? [];
  // Center the #1 spot: render order 2nd, 1st, 3rd.
  const podiumOrder = [podium[1], podium[0], podium[2]].filter(Boolean) as LeaderboardRow[];

  return (
    <main className="container lb">
      <header className="lb__head">
        <span className="lb__eyebrow"><Gift width={15} height={15} /> BIDit Points</span>
        <h1 className="display lb__title">Points Leaderboard</h1>
        <p className="lb__sub">
          Earn Points For Future Airdrops And Prizes! — <Link to="/docs#points">Learn More In Docs</Link>
        </p>
      </header>

      {error && <div className="auth__error">{error}</div>}

      {rows && rows.length === 0 && (
        <div className="lb__empty card">
          <Gift width={26} height={26} />
          <b>The board is wide open</b>
          <p className="muted">No points earned yet — the first bid, win or sale takes the crown.</p>
          <Link className="btn btn-primary" to="/points">Start earning points <ArrowRight width={16} height={16} /></Link>
        </div>
      )}

      {podium.length > 0 && (
        <div className="lb__podium">
          {podiumOrder.map((r) => (
            <div key={r.rank} className={`lb__pod card lb__pod--${r.rank}`}>
              <span className="lb__pod-medal">{MEDALS[r.rank - 1]}</span>
              <span className={`lb__pod-ava${r.rank === 1 ? ' gold' : ''}`}>
                <Avatar handle={r.handle} src={r.avatarUrl} size={r.rank === 1 ? 84 : 64} />
              </span>
              <b className="lb__pod-handle">@{r.handle}</b>
              <span className="lb__pod-pts">{fmt(r.points)} <em>pts</em></span>
            </div>
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <div className="lb__list card">
          {rest.map((r) => (
            <div key={r.rank} className="lb__row">
              <span className="lb__rank">{r.rank}</span>
              <Avatar handle={r.handle} src={r.avatarUrl} size={34} />
              <b className="lb__handle">@{r.handle}</b>
              <span className="lb__pts">{fmt(r.points)} pts</span>
            </div>
          ))}
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="lb__cta">
          <span className="muted">Every $1 spent is 100 points · every $1 sold is 20 points.</span>
          <Link className="btn btn-primary" to="/points">Earn points <ArrowRight width={16} height={16} /></Link>
        </div>
      )}
    </main>
  );
}
