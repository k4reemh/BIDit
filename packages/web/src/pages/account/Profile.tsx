import { useState } from 'react';
import { useAccount } from '../../components/AccountLayout';
import Avatar from '../../components/Avatar';
import ImageUpload from '../../components/ImageUpload';
import { updateMe } from '../../api';
import { Check } from '../../icons';

export default function Profile() {
  const { session, setSession } = useAccount();
  const [displayName, setDisplayName] = useState(session.displayName ?? '');
  const [avatarUrl, setAvatarUrl] = useState(session.avatarUrl ?? '');
  const [bio, setBio] = useState(session.bio ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty =
    displayName !== (session.displayName ?? '') ||
    avatarUrl !== (session.avatarUrl ?? '') ||
    bio !== (session.bio ?? '');

  const save = async () => {
    setBusy(true);
    try {
      setSession(await updateMe({ displayName, avatarUrl, bio }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Profile</h1>
        <p className="muted">This is how you show up across BIDit.</p>
      </div>
      <div className="card acct-card">
        <div className="pf__top">
          {avatarUrl ? (
            <img className="pf__av" src={avatarUrl} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
          ) : (
            <Avatar handle={session.handle} size={68} />
          )}
          <div className="pf__avmeta">
            <b>{session.displayName || `@${session.handle}`}</b>
            <span className="muted">0 Followers · 0 Following</span>
          </div>
        </div>

        <div className="fld">
          <label>Display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
        </div>
        <div className="fld">
          <label>Profile picture <span className="muted">— optional</span></label>
          <ImageUpload
            value={avatarUrl}
            onChange={setAvatarUrl}
            label="Drag a photo here, or click to upload"
            hint="PNG or JPG"
          />
        </div>
        <div className="fld">
          <label>Bio <span className="muted">— optional</span></label>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="What do you collect?" rows={3} />
        </div>
        <div className="fld">
          <label>Username</label>
          <input value={`@${session.handle}`} disabled />
        </div>
        <div className="fld">
          <label>Email</label>
          <input value={session.email ?? ''} disabled />
        </div>

        <div className="acct-actions">
          <button className="btn btn-primary" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {saved && <span className="acct-saved"><Check width={16} height={16} /> Saved</span>}
        </div>
      </div>
    </>
  );
}
