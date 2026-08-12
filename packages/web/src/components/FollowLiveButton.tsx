import { useEffect, useState } from 'react';
import { getMyAlerts, setSellerLiveAlert, type Session } from '../api';
import { Bell } from '../icons';

/**
 * "Notify me when live" toggle for a seller's watch page. Opting in adds a
 * go-live alert (in-app + email) for this streamer. Signed-out users are sent to
 * auth. State is read once from the viewer's alert prefs.
 */
export default function FollowLiveButton({
  sellerId,
  session,
  onAuth,
}: {
  sellerId: string;
  session: Session | null;
  onAuth: () => void;
}) {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) {
      setOn(false);
      setReady(true);
      return;
    }
    let alive = true;
    getMyAlerts()
      .then((a) => {
        if (alive) {
          setOn(a.sellers.some((s) => s.sellerId === sellerId));
          setReady(true);
        }
      })
      .catch(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [session, sellerId]);

  const toggle = async () => {
    if (!session) return onAuth();
    const next = !on;
    setOn(next); // optimistic
    setBusy(true);
    try {
      await setSellerLiveAlert(sellerId, next);
    } catch {
      setOn(!next); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`notify-btn${on ? ' is-on' : ''}`}
      onClick={toggle}
      disabled={busy || !ready}
      aria-pressed={on}
      title={on ? 'You will be alerted when they go live' : 'Get alerted when they go live'}
    >
      <Bell width={16} height={16} /> {on ? 'Alerts on' : 'Notify me when live'}
    </button>
  );
}
