import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNotifications, markNotificationsRead, type Notifs } from '../api';
import { Bell } from '../icons';

const ago = (ms: number) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/** Notification bell: polls every 30s, badge shows unread count, dropdown lists
 *  recent items and marks all read on open. */
export default function NotificationBell() {
  const [data, setData] = useState<Notifs | null>(null);
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  const load = () => getNotifications().then(setData).catch(() => {});
  useEffect(() => {
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && data && data.unread > 0) {
      try { setData(await markNotificationsRead()); } catch { /* ignore */ }
    }
  };

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  return (
    <div className="nbell" ref={ref}>
      <button className="icon-btn" aria-label="Notifications" onClick={toggle}>
        <Bell />
        {unread > 0 && <span className="nbell__badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="nbell__menu">
          <div className="nbell__head">Notifications</div>
          {items.length === 0 ? (
            <div className="nbell__empty">You’re all caught up.</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                className={`nbell__item${n.read ? '' : ' unread'}`}
                onClick={() => { setOpen(false); if (n.href) nav(n.href); }}
              >
                <div className="nbell__title">{n.title}</div>
                {n.body && <div className="nbell__body">{n.body}</div>}
                <div className="nbell__time">{ago(n.createdAt)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
