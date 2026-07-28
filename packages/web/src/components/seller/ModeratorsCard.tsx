import { useEffect, useState } from 'react';
import { getModerators, addModerator, removeModerator, type Moderator } from '../../api';
import Avatar from '../Avatar';
import { Shield, Plus, Trash } from '../../icons';

/**
 * Moderators for the seller's live chat. They can delete messages, block
 * viewers and change the chat cooldown in this room, and nothing else: no
 * listings, no orders, no money. Only the seller can add or remove them.
 */
export default function ModeratorsCard() {
  const [mods, setMods] = useState<Moderator[] | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    getModerators()
      .then((m) => { if (alive) setMods(m); })
      .catch(() => { if (alive) setMods([]); });
    return () => { alive = false; };
  }, []);

  const add = async () => {
    if (!handle.trim()) return;
    setBusy(true);
    setError('');
    try {
      await addModerator(handle.trim());
      setMods(await getModerators());
      setHandle('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that moderator.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    setMods((m) => m?.filter((x) => x.userId !== userId) ?? m); // optimistic
    try {
      await removeModerator(userId);
    } catch {
      setMods(await getModerators().catch(() => mods ?? []));
    }
  };

  return (
    <div className="card acct-card">
      <h3 className="acct-sub">Chat moderators</h3>
      <p className="muted acct-note">
        Moderators can delete messages, block viewers and set the chat cooldown in your room. They
        can&rsquo;t touch your listings, orders or payouts.
      </p>

      {error && <div className="auth__error">{error}</div>}

      <div className="fld-row mod__add">
        <div className="fld">
          <label>Add by username</label>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@username"
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          />
        </div>
        <button className="btn btn-ghost" onClick={() => void add()} disabled={busy || !handle.trim()}>
          <Plus width={16} height={16} /> {busy ? 'Adding…' : 'Add'}
        </button>
      </div>

      {mods === null ? (
        <p className="muted acct-note">Loading…</p>
      ) : mods.length === 0 ? (
        <div className="mod__empty">
          <Shield width={18} height={18} />
          <span>No moderators yet. You&rsquo;re the only one who can moderate your chat.</span>
        </div>
      ) : (
        <div className="mod__list">
          {mods.map((m) => (
            <div className="mod__row" key={m.userId}>
              <Avatar handle={m.handle} size={26} />
              <span className="mod__handle">@{m.handle}</span>
              <button className="mod__remove" onClick={() => void remove(m.userId)} title={`Remove @${m.handle}`}>
                <Trash width={14} height={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
