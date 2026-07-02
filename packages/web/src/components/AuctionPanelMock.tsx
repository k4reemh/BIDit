import Avatar from './Avatar';
import { FEATURED } from '../data';

/** A premium static replica of the in-stream BIDit auction panel, for the hero. */
export default function AuctionPanelMock() {
  const feed = [
    { h: 'luna_degen', a: 64 },
    { h: 'apex_whale', a: 59 },
    { h: 'degen_max', a: 55 },
  ];
  return (
    <div
      style={{
        width: 360,
        borderRadius: 22,
        padding: 1.5,
        background: 'linear-gradient(160deg, rgba(79,140,255,0.7), rgba(37,230,166,0.25) 42%, rgba(20,24,33,0.2) 72%)',
        boxShadow: '0 40px 90px rgba(0,0,0,0.6), 0 0 70px rgba(37,230,166,0.18)',
        fontFamily: 'var(--font)',
      }}
    >
      <div style={{ borderRadius: 21, background: 'rgba(10,13,19,0.96)', overflow: 'hidden' }}>
        {/* head */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 15px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>
            <span className="grad-text">BID</span>it
          </span>
          <span className="live-badge" style={{ padding: '3px 7px', fontSize: 10 }}>
            <span className="dot" /> LIVE
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--muted)' }}>
            <Avatar handle="kanto_kid" size={18} hue={150} /> kanto_kid
          </span>
        </div>
        {/* body */}
        <div style={{ padding: 15 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ width: 70, height: 70, borderRadius: 12, padding: 2, background: 'var(--grad)', flex: 'none' }}>
              <img src={FEATURED[0].image} style={{ width: '100%', height: '100%', borderRadius: 10, objectFit: 'cover', background: '#11151d' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15.5, lineHeight: 1.25 }}>Charizard — Base Set Holo</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 12.5, color: 'var(--green)', fontWeight: 700 }}>
                <Avatar handle="luna_degen" size={16} /> You're leading
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 11 }}>
            {feed.map((f) => (
              <div key={f.h} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
                <Avatar handle={f.h} size={15} />
                <b style={{ color: 'var(--ink)', fontWeight: 700 }}>{f.h}</b>
                <span style={{ color: 'var(--green)' }}>${f.a}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 13 }}>
            <div>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)' }}>Current bid</div>
              <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.02em' }}>$64</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)' }}>Ends in</div>
              <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1.05, color: 'var(--red)', textShadow: '0 0 16px rgba(255,77,109,0.5)' }}>2.4s</div>
            </div>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: 'rgba(255,255,255,0.07)', overflow: 'hidden', marginTop: 11 }}>
            <div style={{ height: '100%', width: '34%', borderRadius: 999, background: 'linear-gradient(90deg, var(--red), #ff7a45)', boxShadow: '0 0 10px rgba(255,122,69,0.7)' }} />
          </div>
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 13, height: 48, fontSize: 17 }}
          >
            BID&nbsp;&nbsp;$65
          </button>
        </div>
      </div>
    </div>
  );
}
