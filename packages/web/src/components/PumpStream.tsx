import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { getPumpStream } from '../api';

type Status = 'loading' | 'live' | 'offline' | 'error';

const POLL_MS = 20_000; // while offline, re-check for the stream this often

/**
 * Plays a pump.fun livestream directly on our page via LiveKit, no iframe, so it
 * works past pump.fun frame-blocks and geo-blocks. Our backend hands us a
 * watch-only viewer token; the media flows LiveKit → viewer (costs us nothing).
 * While offline it keeps polling, so the stream appears (and re-appears after a
 * drop) without a page refresh; the caller renders the `offline` placeholder.
 */
export default function PumpStream({ mint, offline }: { mint: string; offline: React.ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let room: Room | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let noVideo: ReturnType<typeof setTimeout> | undefined;

    // Detach the current room (if any) without letting its Disconnected event
    // count as an unexpected drop: handlers check `room === r` first.
    const drop = () => {
      const r = room;
      room = null;
      r?.disconnect();
    };
    const scheduleRetry = () => {
      if (cancelled) return;
      clearTimeout(retry);
      retry = setTimeout(() => { if (!room) void attempt(); }, POLL_MS);
    };
    const goOffline = () => {
      if (cancelled) return;
      setStatus('offline');
      scheduleRetry();
    };

    const attempt = async () => {
      clearTimeout(noVideo);
      try {
        const s = await getPumpStream(mint);
        if (cancelled) return;
        if (!s.live || !s.token || !s.host) return goOffline();
        drop();
        let gotVideo = false;
        const r = new Room({ adaptiveStream: true, dynacast: true });
        room = r;
        r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Video && videoRef.current) {
            gotVideo = true;
            clearTimeout(noVideo);
            track.attach(videoRef.current);
            setStatus('live');
          } else if (track.kind === Track.Kind.Audio && audioRef.current) {
            track.attach(audioRef.current);
            audioRef.current.muted = true; // autoplay-with-sound is blocked; user unmutes
          }
        });
        // Stream ended / connection lost → back to the placeholder, keep polling.
        r.on(RoomEvent.Disconnected, () => {
          if (room !== r) return; // we dropped it on purpose
          room = null;
          goOffline();
        });
        await r.connect(s.host, s.token);
        if (cancelled) { drop(); return; }
        // Joined but no video track shows up (e.g. a room that lingers after the
        // stream ended) → treat as offline and let the poll try again.
        noVideo = setTimeout(() => {
          if (!cancelled && !gotVideo) { drop(); goOffline(); }
        }, 12_000);
      } catch {
        if (cancelled) return;
        drop();
        setStatus('error');
        scheduleRetry();
      }
    };

    setStatus('loading');
    void attempt();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearTimeout(noVideo);
      drop();
    };
  }, [mint]);

  const unmute = () => {
    setMuted(false);
    if (audioRef.current) {
      audioRef.current.muted = false;
      void audioRef.current.play().catch(() => {});
    }
    if (videoRef.current) void videoRef.current.play().catch(() => {});
  };

  return (
    <div className="pstream">
      <video ref={videoRef} className="pstream__video" autoPlay playsInline muted />
      <audio ref={audioRef} autoPlay />

      {status === 'live' && (
        <>
          <span className="pstream__badge"><span className="dot" /> LIVE</span>
          {muted && (
            <button className="pstream__unmute" onClick={unmute} aria-label="Unmute stream">
              Tap to unmute
            </button>
          )}
        </>
      )}

      {status !== 'live' && (
        <div className="pstream__cover">
          {status === 'loading' ? <span className="muted">Connecting to the stream…</span> : offline}
        </div>
      )}
    </div>
  );
}
