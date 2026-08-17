import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '../components/Avatar';
import { getLeaderboard, getReferralLeaders, type LeaderboardRow, type ReferralLeaderRow } from '../api';
import { Gift, ArrowRight } from '../icons';

const fmt = (n: number) => n.toLocaleString('en-US');

export default function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [refRows, setRefRows] = useState<ReferralLeaderRow[] | null>(null);
  const [tab, setTab] = useState<'points' | 'referrals'>('points');
  const [error, setError] = useState('');

  useEffect(() => {
    getLeaderboard().then(setRows).catch((e) => setError(e instanceof Error ? e.message : 'Couldn’t load the leaderboard.'));
  }, []);

  useEffect(() => {
    if (tab !== 'referrals' || refRows !== null) return;
    getReferralLeaders().then(setRefRows).catch(() => setRefRows([]));
  }, [tab, refRows]);

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
          Earn points for future airdrops and prizes. <Link to="/docs#points">Learn more in Docs</Link>
        </p>
      </header>

      <div className="lb__tabs">
        <button className={`mkt-chip${tab === 'points' ? ' is-on' : ''}`} onClick={() => setTab('points')}>Points</button>
        <button className={`mkt-chip${tab === 'referrals' ? ' is-on' : ''}`} onClick={() => setTab('referrals')}>Referrals</button>
      </div>

      {error && <div className="auth__error">{error}</div>}

      {tab === 'referrals' && (
        <>
          {refRows === null ? (
            <p className="muted" style={{ padding: '24px 0' }}>Loading…</p>
          ) : refRows.length === 0 ? (
            <div className="lb__empty card">
              <Gift width={26} height={26} />
              <b>No qualified referrals yet</b>
              <p className="muted">Share your link from the Points page. First friend in gets you on this board.</p>
              <Link className="btn btn-primary" to="/points">Get your invite link <ArrowRight width={16} height={16} /></Link>
            </div>
          ) : (
            <div className="lb__list card">
              {refRows.map((r, i) => (
                <div key={r.userId} className="lb__row">
                  <span className="lb__rank">{i + 1}</span>
                  <Avatar handle={r.handle} src={r.avatarUrl} size={34} />
                  <b className="lb__handle">@{r.handle}</b>
                  <span className="lb__pts">{fmt(r.qualified)} referral{r.qualified === 1 ? '' : 's'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'points' && rows && rows.length === 0 && (
        <div className="lb__empty card">
          <Gift width={26} height={26} />
          <b>The board is wide open</b>
          <p className="muted">No points earned yet. The first bid, win or sale takes the crown.</p>
          <Link className="btn btn-primary" to="/points">Start earning points <ArrowRight width={16} height={16} /></Link>
        </div>
      )}

      {tab === 'points' && podium.length > 0 && (
        <div className="lb__podium">
          {podiumOrder.map((r) => (
            <div key={r.rank} className={`lb__pod card lb__pod--${r.rank}`}>
              <span className="lb__pod-medal">{r.rank}</span>
              <span className={`lb__pod-ava${r.rank === 1 ? ' gold' : ''}`}>
                <Avatar handle={r.handle} src={r.avatarUrl} size={r.rank === 1 ? 84 : 64} />
              </span>
              <b className="lb__pod-handle">@{r.handle}</b>
              <span className="lb__pod-pts">{fmt(r.points)} <em>pts</em></span>
            </div>
          ))}
        </div>
      )}

      {tab === 'points' && rest.length > 0 && (
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
