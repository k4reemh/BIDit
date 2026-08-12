/**
 * Shared WebRTC helpers for the WHIP (publish) and WHEP (playback) paths against
 * Cloudflare Stream. Both use non-trickle signalling: the SDP we POST must already
 * carry its ICE candidates, so we wait for gathering to finish (bounded) before
 * sending it, and hand the browser a STUN server so it gathers a reachable
 * (server-reflexive) candidate.
 */

/** Public STUN so the browser gathers a server-reflexive candidate. */
export const WEBRTC_ICE: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
};

/** Resolve once ICE gathering completes, or after `timeoutMs` (whichever first),
 *  so `pc.localDescription.sdp` carries the candidates before we POST it. */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(finish, timeoutMs);
  });
}
