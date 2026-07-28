import { XLogo } from '../icons';

/**
 * "Post to X" for a win. Opens X's compose window with the post pre-filled;
 * nothing is posted on the user's behalf and no account is connected — they see
 * the text and choose to send it.
 *
 * The current page rides along as the link, so on a watch page the post points
 * at the stream the item was won on rather than just the homepage.
 */
export default function ShareOnX({
  item,
  kind,
  className = '',
}: {
  /** What they won, e.g. the item title or giveaway prize. */
  item: string;
  kind: 'auction' | 'giveaway';
  className?: string;
}) {
  const what = item.trim() || (kind === 'giveaway' ? 'a prize' : 'a card');
  const text =
    kind === 'giveaway'
      ? `I just won ${what} in a free giveaway with @biditsol!`
      : `I just won ${what} on auction with @biditsol!`;

  const href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(
    typeof window === 'undefined' ? '' : window.location.href,
  )}`;

  return (
    <a
      className={`sharex ${className}`.trim()}
      href={href}
      target="_blank"
      rel="noreferrer"
      // The parent overlays close on background clicks; this must not bubble.
      onClick={(e) => e.stopPropagation()}
    >
      <XLogo width={14} height={14} /> Post to X
    </a>
  );
}
