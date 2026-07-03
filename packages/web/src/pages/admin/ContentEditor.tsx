import { useEffect, useState } from 'react';
import { FIELDS, DEFAULTS } from '../../content';
import { getContent, saveContent } from '../../api';
import { Check } from '../../icons';

const KEY = 'bidit_admin_key';
const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

/** Admin-only copy editor. Passcode-gated (BIDIT_ADMIN_KEY on the backend).
 *  Edits site copy at runtime — no code change, no redeploy. */
export default function ContentEditor() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(KEY) ?? '');
  const [entered, setEntered] = useState(() => !!localStorage.getItem(KEY));
  const [vals, setVals] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const base: Record<string, string> = {};
    for (const f of FIELDS) base[f.key] = DEFAULTS[f.key] ?? '';
    getContent()
      .then((o) => { const merged = { ...base, ...o }; setVals(merged); setInitial(merged); })
      .catch(() => { setVals(base); setInitial(base); });
  }, []);

  const set = (k: string, v: string) => setVals((prev) => ({ ...prev, [k]: v }));

  const unlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminKey.trim()) return;
    localStorage.setItem(KEY, adminKey.trim());
    setEntered(true);
  };

  const lock = () => { localStorage.removeItem(KEY); setEntered(false); };

  const save = async () => {
    const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => v !== (initial[k] ?? '')));
    if (Object.keys(changed).length === 0) { setErr('No changes to save.'); return; }
    setBusy(true); setErr(''); setSaved(false);
    try {
      await saveContent(changed, adminKey.trim());
      localStorage.setItem(KEY, adminKey.trim());
      setInitial(vals);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed.';
      setErr(msg);
      if (/passcode/i.test(msg)) lock();
    } finally {
      setBusy(false);
    }
  };

  if (!entered) {
    return (
      <main className="ce ce--gate">
        <h1 className="display" style={{ fontSize: 26, marginBottom: 8 }}>Content editor</h1>
        <p className="muted" style={{ marginBottom: 18 }}>Enter the admin passcode to edit site copy.</p>
        <form onSubmit={unlock} className="fld">
          <label>Admin passcode</label>
          <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="Passcode" autoFocus />
          <button className="btn btn-primary" style={{ marginTop: 12 }} type="submit">Unlock</button>
        </form>
      </main>
    );
  }

  return (
    <main className="ce">
      <div className="ce__head">
        <div>
          <h1 className="display acct-title">Content editor</h1>
          <p className="muted">Edit site copy — saved changes go live after a refresh. Blank fields fall back to the built-in default.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={lock}>Lock</button>
      </div>
      {err && <div className="auth__error">{err}</div>}
      {GROUPS.map((g) => (
        <div key={g} className="card acct-card">
          <h3 className="acct-sub">{g}</h3>
          {FIELDS.filter((f) => f.group === g).map((f) => (
            <div className="fld" key={f.key}>
              <label>{f.label}</label>
              {f.multiline ? (
                <textarea rows={3} value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="ce__save">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved — refresh to see it live</span>}
      </div>
    </main>
  );
}
