import { useEffect, useRef, useState } from 'react';
import {
  refreshMe,
  enableNativeStreaming,
  setStreamSource,
  getStreamCredentials,
  getHealth,
  type Session,
  type StreamCredentials,
} from '../../api';
import { Check, Copy } from '../../icons';
import { WEBRTC_ICE, waitForIceGathering } from '../../lib/webrtc';

/**
 * "Go live on BIDit" panel: pick where the seller's video comes from (pump.fun or
 * BIDit-hosted), then go live from the browser (WebRTC) or OBS (RTMP). The
 * auction/bid/chat flow is unchanged; this only controls the video.
 */
export default function GoLive({ session, setSession }: { session: Session; setSession: (s: Session) => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const source = session.streamSource ?? 'pumpfun';
  const nativeEnabled = !!session.nativeEnabled;
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<StreamCredentials | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [err, setErr] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    getHealth().then((h) => setAvailable(h.nativeStreaming)).catch(() => setAvailable(false));
    return () => stopBroadcast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = (text: string, which: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(''), 1600);
    });
  };

  const pickNative = async () => {
    setBusy(true);
    setErr('');
    try {
      await enableNativeStreaming();
      setSession(await refreshMe());
    } catch {
      setErr('Native streaming is not available yet.');
    } finally {
      setBusy(false);
    }
  };

  const pickPump = async () => {
    setBusy(true);
    setErr('');
    try {
      await setStreamSource('pumpfun');
      setSession(await refreshMe());
    } finally {
      setBusy(false);
    }
  };

  const loadCreds = async () => {
    try {
      setCreds(await getStreamCredentials());
    } catch {
      setErr('Enable BIDit streaming first.');
    }
  };

  const goLiveBrowser = async () => {
    setErr('');
    // 1) Camera + mic. Distinguish the common failures so the seller knows what to fix.
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    } catch (e) {
      const name = (e as DOMException)?.name;
      setErr(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera and mic are blocked. Click the camera icon in your browser’s address bar, choose Allow, then try again.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera or mic was found. Connect one (or use OBS with the key below) and try again.'
            : 'Could not access your camera and mic. Check the browser’s camera permission, or use OBS with the key below.',
      );
      return;
    }
    mediaRef.current = media;
    if (videoRef.current) videoRef.current.srcObject = media;
    // 2) Publish over WebRTC (WHIP) to Cloudflare.
    try {
      const c = creds ?? (await getStreamCredentials());
      setCreds(c);
      // Mock provider has no real ingest endpoint: streaming isn't configured here.
      if (c.whipUrl.includes('mockcf')) throw new Error('NOT_CONFIGURED');
      const pc = new RTCPeerConnection(WEBRTC_ICE);
      pcRef.current = pc;
      media.getTracks().forEach((t) => pc.addTrack(t, media));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc); // non-trickle WHIP: send a complete offer
      const res = await fetch(c.whipUrl, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription?.sdp ?? offer.sdp ?? '' });
      if (!res.ok) throw new Error(`whip ${res.status}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      setBroadcasting(true);
    } catch (e) {
      stopBroadcast();
      setErr(
        (e as Error)?.message === 'NOT_CONFIGURED'
          ? 'Browser go-live needs BIDit’s streaming to be connected to Cloudflare, which isn’t set up on this environment yet. Finish the Cloudflare setup (or use OBS once it is).'
          : 'Your camera is on, but the stream server rejected the broadcast. Try again in a moment, or stream with OBS using the key below.',
      );
    }
  };

  const stopBroadcast = () => {
    pcRef.current?.close();
    pcRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setBroadcasting(false);
  };

  const watchUrl = `${window.location.origin}/live/@${session.handle}`;

  if (available === false && source !== 'native') {
    return (
      <div className="card acct-card">
        <h3 className="acct-sub">Go live on BIDit <span className="soon-tag">Soon</span></h3>
        <p className="muted acct-note">Host your stream on BIDit, no pump.fun needed. Going live straight from your phone or OBS is coming soon.</p>
      </div>
    );
  }

  return (
    <div className="card acct-card">
      <h3 className="acct-sub">Where you go live</h3>
      <p className="muted acct-note">Stream on pump.fun, or host it on BIDit and go live from your phone or OBS. Either way your auctions run the same.</p>

      <div className="src-toggle">
        <button className={`src-opt${source === 'pumpfun' ? ' is-on' : ''}`} onClick={pickPump} disabled={busy}>
          <b>pump.fun</b>
          <span>Link a coin, stream on pump.fun</span>
        </button>
        <button className={`src-opt${source === 'native' ? ' is-on' : ''}`} onClick={pickNative} disabled={busy}>
          <b>BIDit</b>
          <span>Host it here, phone or OBS</span>
        </button>
      </div>

      {err && <div className="auth__error" style={{ marginTop: 12 }}>{err}</div>}

      {source === 'native' && nativeEnabled && (
        <div className="golive">
          <div className="golive__url">
            <span className="muted">Your stream page</span>
            <code>{watchUrl}</code>
            <button className="addr__copy" onClick={() => copy(watchUrl, 'url')}>{copied === 'url' ? <Check width={15} height={15} /> : <Copy width={15} height={15} />}</button>
          </div>

          {/* One-click browser broadcast */}
          <div className="golive__browser">
            <video ref={videoRef} className={`golive__preview${broadcasting ? ' is-on' : ''}`} autoPlay playsInline muted />
            {!broadcasting ? (
              <button className="btn btn-primary" onClick={goLiveBrowser}>Go live from this browser</button>
            ) : (
              <button className="btn btn-ghost" onClick={stopBroadcast}>Stop broadcast</button>
            )}
            <p className="muted" style={{ fontSize: 12.5 }}>Uses your webcam and mic. Great for phone rips. For a full setup, use OBS below.</p>
          </div>

          {/* OBS / RTMP */}
          <div className="golive__obs">
            {!creds ? (
              <button className="btn btn-ghost btn-sm" onClick={loadCreds}>Show OBS stream key</button>
            ) : (
              <>
                <label className="golive__field">
                  <span>Server (RTMPS)</span>
                  <div className="golive__val"><code>{creds.rtmpsUrl}</code><button className="addr__copy" onClick={() => copy(creds.rtmpsUrl, 'url2')}>{copied === 'url2' ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}</button></div>
                </label>
                <label className="golive__field">
                  <span>Stream key <button className="linklike" onClick={() => setShowKey((v) => !v)}>{showKey ? 'hide' : 'show'}</button></span>
                  <div className="golive__val"><code>{showKey ? creds.streamKey : '•'.repeat(24)}</code><button className="addr__copy" onClick={() => copy(creds.streamKey, 'key')}>{copied === 'key' ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}</button></div>
                </label>
                <p className="muted" style={{ fontSize: 12 }}>Paste these into OBS (Settings → Stream → Custom). Keep your stream key private.</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
