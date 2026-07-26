import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import { openRoom, type RoomController, type ChatLine } from '../realtime';
import type { Session } from '../api';
import { Chat, ArrowRight, Trash, Shield } from '../icons';

const DEFAULT_COOLDOWN_MS = 5000; // fallback until CHAT_HISTORY delivers the room's value

/**
 * Live room chat — a Twitch-style feed for the live coin page. Viewers post short
 * messages the seller reads on stream. Opens its own room socket (token-gated, so
 * signed-out viewers get a sign-in CTA). The seller (room owner) sees inline
 * delete + block controls. Text is rendered as plain React children, so it's
 * escaped by construction — no HTML injection.
 */
export default function ChatPanel({
  room,
  session,
  onAuth,
}: {
  room: string;
  session: Session | null;
  onAuth: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownMs, setCooldownMs] = useState(DEFAULT_COOLDOWN_MS); // the room's setting, from CHAT_HISTORY
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState('');
  const ctl = useRef<RoomController | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const [, setTick] = useState(0);
  const isOwner = !!session && session.userId === room;

  useEffect(() => {
    if (!session) return; // socket is token-gated — signed-out shows the CTA below
    const c = openRoom(room, {
      onChatHistory: (list, cd) => { setMsgs(list); setCooldownMs(cd); },
      onChat: (m) => setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m].slice(-200))),
      onChatDeleted: (id) => setMsgs((prev) => prev.filter((m) => m.id !== id)),
      onChatRejected: (r) => {
        if (r.reason === 'BLOCKED') { setBlocked(true); setNotice('You can’t chat in this room.'); }
        else if (r.reason === 'COOLDOWN') setCooldownUntil(Date.now() + (r.retryMs ?? cooldownMs));
        else if (r.reason === 'TOO_LONG') setNotice('That message is too long.');
        else if (r.reason === 'EMPTY') setNotice('Type a message first.');
      },
    });
    ctl.current = c;
    return () => c.close();
  }, [room, session?.userId]);

  // Keep the newest message in view by scrolling the feed itself — never
  // scrollIntoView, which scrolls every ancestor and yanks the whole page.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  // Tick the cooldown countdown.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const cooling = Math.max(0, cooldownUntil - Date.now());
  const canSend = !!session && !blocked && cooling === 0 && text.trim().length > 0;

  const send = () => {
    if (!session) return onAuth();
    if (blocked || cooling > 0) return;
    const t = text.trim();
    if (!t) return;
    ctl.current?.sendChat(t);
    setText('');
    setNotice('');
    if (cooldownMs > 0) setCooldownUntil(Date.now() + cooldownMs); // optimistic; server is authoritative
  };

  return (
    <aside className="chat card">
      <div className="chat__head"><Chat width={16} height={16} /> Live chat</div>

      <div className="chat__feed" ref={feedRef}>
        {msgs.length === 0 && <p className="chat__empty">No messages yet. Say hi.</p>}
        {msgs.map((m) => (
          <div key={m.id} className="chat__msg">
            <Avatar handle={m.handle} size={26} />
            <div className="chat__bubble">
              <span className="chat__who">@{m.handle}</span>{' '}
              <span className="chat__text">{m.text}</span>
            </div>
            {isOwner && m.senderId !== room && (
              <div className="chat__mod">
                <button title="Delete message" onClick={() => ctl.current?.deleteChat(m.id)}><Trash width={13} height={13} /></button>
                <button title="Block user" onClick={() => ctl.current?.blockUser(m.senderId)}><Shield width={13} height={13} /></button>
              </div>
            )}
          </div>
        ))}
      </div>

      {notice && <div className="chat__notice">{notice}</div>}

      {session ? (
        <div className="chat__input">
          <input
            value={text}
            maxLength={300}
            disabled={blocked}
            placeholder={blocked ? 'You’re blocked from this chat' : 'Type something…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <button className="btn btn-primary btn-sm chat__send" disabled={!canSend} onClick={send} aria-label="Send message">
            {cooling > 0 ? `${Math.ceil(cooling / 1000)}s` : <ArrowRight width={16} height={16} />}
          </button>
        </div>
      ) : (
        <button className="btn btn-ghost chat__signin" onClick={onAuth}>Sign in to join the chat</button>
      )}
    </aside>
  );
}
