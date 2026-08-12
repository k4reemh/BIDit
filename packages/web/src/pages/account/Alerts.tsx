import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from '../../components/AccountLayout';
import { getMyAlerts, setSellerLiveAlert, setCategoryLiveAlert, type AlertPrefs } from '../../api';
import { CATEGORIES } from '../../data';
import { Bell, Check } from '../../icons';

/** Manage go-live alerts: which sellers you follow, and which categories ping you
 *  whenever any stream in them goes live. */
export default function Alerts() {
  useAccount();
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [cats, setCats] = useState<Set<string>>(new Set());

  useEffect(() => {
    getMyAlerts()
      .then((a) => {
        setPrefs(a);
        setCats(new Set(a.categories));
      })
      .catch(() => setPrefs({ sellers: [], categories: [] }));
  }, []);

  const toggleCat = async (name: string) => {
    const on = !cats.has(name);
    setCats((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
    try {
      await setCategoryLiveAlert(name, on);
    } catch {
      // revert
      setCats((prev) => {
        const next = new Set(prev);
        if (on) next.delete(name);
        else next.add(name);
        return next;
      });
    }
  };

  const unfollow = async (sellerId: string) => {
    setPrefs((p) => (p ? { ...p, sellers: p.sellers.filter((s) => s.sellerId !== sellerId) } : p));
    try {
      await setSellerLiveAlert(sellerId, false);
    } catch {
      // best-effort; a reload will resync
    }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Live alerts</h1>
        <p className="muted">Get notified the moment a seller you follow, or any stream in a category you pick, goes live.</p>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Categories</h3>
        <p className="muted acct-note">We will ping you whenever any stream in these categories goes live.</p>
        <div className="alert-cats">
          {CATEGORIES.map((c) => {
            const on = cats.has(c.name);
            return (
              <button
                key={c.name}
                className={`alert-cat${on ? ' is-on' : ''}`}
                onClick={() => toggleCat(c.name)}
                aria-pressed={on}
              >
                {on ? <Check width={15} height={15} /> : <Bell width={15} height={15} />}
                {c.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Sellers you follow</h3>
        {!prefs ? (
          <p className="muted acct-note">Loading…</p>
        ) : prefs.sellers.length === 0 ? (
          <p className="muted acct-note">
            You are not following anyone yet. Open a seller&rsquo;s page and tap <b>Notify me when live</b>.
          </p>
        ) : (
          <ul className="alert-sellers">
            {prefs.sellers.map((s) => (
              <li key={s.sellerId}>
                <Link to={`/live/@${s.handle}`} className="alert-seller__name">@{s.handle}</Link>
                <button className="btn btn-ghost btn-sm" onClick={() => unfollow(s.sellerId)}>Unfollow</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
