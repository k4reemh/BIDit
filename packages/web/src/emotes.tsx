import type { ReactNode } from 'react';

/**
 * BIDit emotes: named tokens typed as :NAME: in chat, rendered as semi-3D
 * animated glyphs. Messages store plain text (the token), so emotes cost
 * nothing server-side and old clients just see ":BUNS:".
 */

export interface EmoteDef {
  /** Canonical token name (typed as :NAME:, matched case-insensitively). */
  name: string;
  glyph: string;
  title: string;
}

export const EMOTES: readonly EmoteDef[] = [
  { name: 'BUNS', glyph: '🍞', title: 'BUNS' },
];

const BY_NAME = new Map(EMOTES.map((e) => [e.name.toLowerCase(), e]));

/** One rendered emote: bobbing glyph over a squashing ground shadow. */
export function Emote({ def, big }: { def: EmoteDef; big?: boolean }) {
  return (
    <span className={`emote${big ? ' is-big' : ''}`} title={`:${def.name}:`} aria-label={def.title}>
      <span className="emote__glyph">{def.glyph}</span>
      <span className="emote__shadow" aria-hidden />
    </span>
  );
}

const TOKEN = /:([a-zA-Z0-9_]{2,20}):/g;

/**
 * Render chat text with emote tokens replaced by animated emotes. A message
 * that is nothing but emotes (and whitespace) gets them rendered large,
 * Twitch-style. Unknown tokens pass through as plain text.
 */
export function renderChatText(text: string): ReactNode {
  TOKEN.lastIndex = 0;
  if (!TOKEN.test(text)) return text;
  TOKEN.lastIndex = 0;

  const parts: { emote?: EmoteDef; text?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    const def = BY_NAME.get(m[1]!.toLowerCase());
    if (!def) continue; // unknown token: stays inside the surrounding text
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ emote: def });
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push({ text: text.slice(last) });

  const emotesOnly = parts.every((p) => p.emote || (p.text ?? '').trim() === '');
  return parts.map((p, i) =>
    p.emote ? <Emote key={i} def={p.emote} big={emotesOnly} /> : <span key={i}>{p.text}</span>,
  );
}
