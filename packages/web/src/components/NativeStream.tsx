import { useEffect, useRef, useState } from 'react';
import { getStreamStatus } from '../api';

/**
 * Player for a BIDit-hosted (Cloudflare Stream Live) seller. Polls the room's
 * stream status to notice go-live, then plays the Cloudflare iframe. On the mock
 * provider (dev) there is no real stream, so a "live preview" placeholder stands
 * in, which is enough to verify the go-live -> watch flow end to end.
 */
const POLL_MS = 12_000;

export default function NativeStream({
  room,
  initialLive,
  initialIframe,
  offline,
}: {
  room: string;
  initialLive: boolean;
  initialIframe: string | null;
  offline: React.ReactNode;
}) {
  const [live, setLive] = useState(initialLive);
  const [iframe, setIframe] = useState<string | null>(initialIframe);
  const [mock, setMock] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await getStreamStatus(room);
        if (!alive) return;
        setLive(s.live);
        setIframe(s.iframeUrl);
        setMock(s.mock);
      } catch {
        /* keep the last known state; try again next tick */
      }
      timer.current = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [room]);

  if (live && iframe && !mock) {
    const src = `${iframe}?autoplay=true&muted=true&controls=true&preload=auto`;
    return (
      <div className="pstream">
        <iframe
          className="pstream__video"
          src={src}
          title="Live stream"
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
          style={{ border: 0 }}
        />
        <span className="pstream__badge"><span className="dot" /> LIVE</span>
      </div>
    );
  }

  if (live && mock) {
    // Dev preview: real Cloudflare video isn't configured, but the seller IS live.
    return (
      <div className="pstream">
        <div className="theater__art theater__art--ph" />
        <div className="theater__scrim" />
        <span className="pstream__badge"><span className="dot" /> LIVE</span>
        <div className="theater__center">
          <div className="theater__eyebrow">Live on BIDit</div>
          <p className="theater__note">Native stream preview. With Cloudflare configured, the seller’s video plays here.</p>
        </div>
      </div>
    );
  }

  return <div className="pstream">{offline}</div>;
}
