import { useEffect, useRef, useState } from 'react';
import { getStreamStatus } from '../api';
import { WEBRTC_ICE, waitForIceGathering } from '../lib/webrtc';

/**
 * Player for a BIDit-hosted (Cloudflare Stream Live) seller. Polls the room's
 * stream status to notice go-live, then plays the video.
 *
 * Latency: it prefers WebRTC playback (WHEP) for sub-second, glass-to-glass
 * latency, and falls back to the Cloudflare iframe player (low-latency HLS, a
 * few seconds) if WebRTC can't connect. On the mock provider (dev) there is no
 * real stream, so a "live preview" placeholder stands in, which is enough to
 * verify the go-live -> watch flow end to end.
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
  const [whep, setWhep] = useState<string | null>(null);
  const [mock, setMock] = useState(false);
  // Flip to the iframe if WebRTC playback can't establish (blocked, unsupported).
  const [whepFailed, setWhepFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // ---- poll go-live status ----
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await getStreamStatus(room);
        if (!alive) return;
        setLive(s.live);
        setIframe(s.iframeUrl);
        setWhep(s.whepUrl);
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

  const useWhep = live && !mock && !!whep && !whepFailed;

  // ---- WHEP (WebRTC) playback: sub-second latency ----
  useEffect(() => {
    if (!useWhep || !whep) return;
    let cancelled = false;
    const pc = new RTCPeerConnection(WEBRTC_ICE);
    pcRef.current = pc;
    // Receive-only: we only pull the seller's audio + video.
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      if (videoRef.current && e.streams[0]) videoRef.current.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !cancelled) setWhepFailed(true);
    };

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc); // non-trickle WHEP: send a complete offer
        const res = await fetch(whep, {
          method: 'POST',
          headers: { 'content-type': 'application/sdp' },
          body: pc.localDescription?.sdp ?? offer.sdp ?? '',
        });
        if (!res.ok) throw new Error(`whep ${res.status}`);
        const answer = await res.text();
        if (cancelled) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch {
        if (!cancelled) setWhepFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
      pcRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [useWhep, whep]);

  // A new go-live (fresh whep url) deserves a fresh WHEP attempt.
  useEffect(() => {
    setWhepFailed(false);
  }, [whep, room]);

  if (useWhep) {
    return (
      <div className="pstream">
        <video ref={videoRef} className="pstream__video" autoPlay playsInline muted controls />
        <span className="pstream__badge"><span className="dot" /> LIVE</span>
      </div>
    );
  }

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
