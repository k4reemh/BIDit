import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { getPumpStream } from '../api';

type Status = 'loading' | 'live' | 'offline' | 'error';

/**
 * Plays a pump.fun livestream directly on our page via LiveKit — no iframe, so it
 * works past pump.fun frame-blocks and geo-blocks. Our backend hands us a
 * watch-only viewer token; the media flows LiveKit → viewer (costs us nothing).
 * Falls back to `offline` (the caller renders its own placeholder) when not live.
 */
export default function PumpStream({ mint, offline }: { mint: string; offline: React.ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let room: Room | null = null;
    let noVideo: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      setStatus('loading');
      try {
        const s = await getPumpStream(mint);
        if (cancelled) return;
        if (!s.live || !s.token || !s.host) {
          setStatus('offline');
          return;
        }
        room = new Room({ adaptiveStream: true, dynacast: true });
        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Video && videoRef.current) {
            clearTimeout(noVideo);
            track.attach(videoRef.current);
            setStatus('live');
          } else if (track.kind === Track.Kind.Audio && audioRef.current) {
            track.attach(audioRef.current);
            audioRef.current.muted = true; // autoplay-with-sound is blocked; user unmutes
          }
        });
        room.on(RoomEvent.Disconnected, () => !cancelled && setStatus('offline'));
        await room.connect(s.host, s.token);
        if (cancelled) { room.disconnect(); return; }
        // Joined but no video track shows up (e.g. a room that lingers after the
        // stream ended) → treat as offline instead of spinning forever.
        noVideo = setTimeout(() => !cancelled && setStatus((st) => (st === 'live' ? st : 'offline')), 12_000);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(noVideo);
      room?.disconnect();
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
              🔇 Tap to unmute
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
