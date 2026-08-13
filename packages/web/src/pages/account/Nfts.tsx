import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from '../../components/AccountLayout';
import {
  getMyNfts,
  armNftDeposit,
  withdrawNftApi,
  listNftForAuction,
  unlistNftApi,
  type NftAsset,
} from '../../api';
import { Check, Copy, Radio, Tag } from '../../icons';

const DURATIONS = [
  { h: 12, label: '12 hours' },
  { h: 24, label: '24 hours' },
  { h: 48, label: '2 days' },
  { h: 72, label: '3 days' },
  { h: 168, label: '7 days' },
];

/**
 * NFT custody home: deposit NFTs into your BIDit account, auction them (single
 * or batch) on stream or the marketplace, withdraw them to any wallet.
 */
export default function Nfts() {
  useAccount();
  const [assets, setAssets] = useState<NftAsset[] | null>(null);
  const [depositAddr, setDepositAddr] = useState('');
  const [watchUntil, setWatchUntil] = useState(0);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withdrawFor, setWithdrawFor] = useState<string | null>(null);
  const [withdrawAddr, setWithdrawAddr] = useState('');
  const [auctionOpen, setAuctionOpen] = useState(false);
  const [startBid, setStartBid] = useState('');
  const [mode, setMode] = useState<'stream' | 'market'>('market');
  const [durationHours, setDurationHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => getMyNfts().then(setAssets).catch(() => setAssets((prev) => prev ?? []));
  useEffect(() => {
    void load();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  // While armed, poll so a detected deposit appears without a manual refresh.
  const watching = watchUntil > Date.now();
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (watching) timer.current = setInterval(load, 8000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [watching]);

  const arm = async () => {
    setErr('');
    try {
      const r = await armNftDeposit();
      setDepositAddr(r.depositAddress);
      setWatchUntil(r.watchUntil);
    } catch {
      setErr('Could not start the deposit flow. Try again.');
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(depositAddr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const withdraw = async (assetId: string) => {
    setErr('');
    setBusy(true);
    try {
      await withdrawNftApi(assetId, withdrawAddr.trim());
      setWithdrawFor(null);
      setWithdrawAddr('');
      setFlash('Withdrawal started. It usually lands within a minute.');
      await load();
    } catch (e) {
      setErr((e as Error).message || 'Withdrawal failed.');
    } finally {
      setBusy(false);
    }
  };

  const startAuction = async () => {
    setErr('');
    setBusy(true);
    try {
      const created = await listNftForAuction({
        assetIds: [...selected],
        startingBid: startBid,
        mode,
        durationHours: mode === 'market' ? durationHours : undefined,
      });
      setSelected(new Set());
      setAuctionOpen(false);
      setStartBid('');
      setFlash(
        mode === 'market'
          ? 'Your NFT auction is live on the marketplace.'
          : 'Queued for your stream. Run it from Seller → Live like any item.',
      );
      await load();
      if (mode === 'market' && created.auctionId) {
        window.location.href = `/marketplace/${created.auctionId}`;
      }
    } catch (e) {
      setErr((e as Error).message || 'Could not start the auction.');
    } finally {
      setBusy(false);
    }
  };

  const unlist = async (listingId: string) => {
    setErr('');
    try {
      await unlistNftApi(listingId);
      await load();
    } catch (e) {
      setErr((e as Error).message || 'Could not unlist.');
    }
  };

  const selectable = (a: NftAsset) => !a.locked && a.status === 'HELD';

  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">My NFTs</h1>
        <p className="muted">Deposit NFTs into BIDit, auction them live or on the marketplace, withdraw anytime.</p>
      </div>

      <div className="card acct-card">
        <h3 className="acct-sub">Deposit an NFT</h3>
        <p className="muted acct-note">
          Send a Solana NFT to your BIDit deposit address and it appears here, ready to auction.
          Winners get it credited instantly; you keep custody rights until the hammer falls.
        </p>
        {!depositAddr ? (
          <button className="btn btn-primary" onClick={arm}>Show my deposit address</button>
        ) : (
          <div className="nftdep">
            <div className="golive__val">
              <code>{depositAddr}</code>
              <button className="addr__copy" onClick={copy}>{copied ? <Check width={15} height={15} /> : <Copy width={15} height={15} />}</button>
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              {watching ? (
                <><Radio width={13} height={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                Watching for your NFT. It shows up below within a minute of confirming.</>
              ) : (
                <>The watch window ended. <button className="linklike" onClick={arm}>Restart it</button> before sending.</>
              )}
            </p>
          </div>
        )}
      </div>

      {flash && <div className="mkt-item__flash" style={{ marginBottom: 14 }}>{flash}</div>}
      {err && <div className="auth__error" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="card acct-card">
        <div className="nft-head">
          <h3 className="acct-sub" style={{ margin: 0 }}>Your collection</h3>
          {selected.size > 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => setAuctionOpen(true)}>
              <Tag width={14} height={14} style={{ marginRight: 5, verticalAlign: '-2px' }} />
              Auction {selected.size === 1 ? 'this NFT' : `these ${selected.size} as a batch`}
            </button>
          )}
        </div>

        {assets === null ? (
          <p className="muted acct-note">Loading…</p>
        ) : assets.length === 0 ? (
          <p className="muted acct-note">Nothing here yet. Deposit an NFT above to get started.</p>
        ) : (
          <div className="nft-grid">
            {assets.map((a) => (
              <div key={a.id} className={`nft-card${selected.has(a.id) ? ' is-sel' : ''}`}>
                <button
                  className="nft-card__ph"
                  onClick={() => selectable(a) && toggle(a.id)}
                  disabled={!selectable(a)}
                  title={selectable(a) ? 'Select for auction' : undefined}
                >
                  {a.image ? <img src={a.image} alt="" loading="lazy" /> : <div className="mkt-card__noimg" />}
                  {selected.has(a.id) && <span className="nft-card__tick"><Check width={14} height={14} /></span>}
                  {a.locked && a.status === 'HELD' && <span className="nft-card__state">On auction</span>}
                  {a.status === 'WITHDRAWING' && <span className="nft-card__state">Withdrawing…</span>}
                </button>
                <div className="nft-card__body">
                  <b className="nft-card__name">{a.name ?? `${a.mint.slice(0, 6)}…`}</b>
                  {a.collection && <span className="muted nft-card__coll">{a.collection}</span>}
                  {a.standard === 'ProgrammableNonFungible' && (
                    <span className="nft-card__warn">pNFT: withdrawals may need support</span>
                  )}
                  <div className="nft-card__actions">
                    {a.locked && a.status === 'HELD' && a.listingId ? (
                      <>
                        {a.marketplace && <Link className="linklike" to="/marketplace">View auction</Link>}
                        <button className="linklike" onClick={() => unlist(a.listingId!)}>Unlist</button>
                      </>
                    ) : selectable(a) ? (
                      withdrawFor === a.id ? (
                        <div className="nft-card__withdraw">
                          <input
                            placeholder="Your Solana wallet address"
                            value={withdrawAddr}
                            onChange={(e) => setWithdrawAddr(e.target.value)}
                          />
                          <button className="btn btn-primary btn-sm" onClick={() => withdraw(a.id)} disabled={busy || !withdrawAddr.trim()}>Send</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => { setWithdrawFor(null); setWithdrawAddr(''); }}>Cancel</button>
                        </div>
                      ) : (
                        <button className="linklike" onClick={() => { setWithdrawFor(a.id); setErr(''); }}>Withdraw</button>
                      )
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {auctionOpen && (
        <div className="nft-modal" role="dialog" aria-label="Start an NFT auction">
          <div className="nft-modal__card card">
            <h3 className="acct-sub">Auction {selected.size === 1 ? 'your NFT' : `${selected.size} NFTs as one batch`}</h3>
            <div className="fld">
              <label>Starting bid (USDC)</label>
              <input inputMode="decimal" value={startBid} onChange={(e) => setStartBid(e.target.value)} placeholder="e.g. 50" />
            </div>
            <div className="fld">
              <label>Where</label>
              <div className="src-toggle">
                <button className={`src-opt${mode === 'market' ? ' is-on' : ''}`} onClick={() => setMode('market')}>
                  <b>Marketplace</b><span>Timed auction, starts now</span>
                </button>
                <button className={`src-opt${mode === 'stream' ? ' is-on' : ''}`} onClick={() => setMode('stream')}>
                  <b>My stream</b><span>Queued for your live room</span>
                </button>
              </div>
            </div>
            {mode === 'market' && (
              <div className="fld">
                <label>Auction length</label>
                <select value={durationHours} onChange={(e) => setDurationHours(Number(e.target.value))}>
                  {DURATIONS.map((d) => <option key={d.h} value={d.h}>{d.label}</option>)}
                </select>
              </div>
            )}
            <p className="muted" style={{ fontSize: 12.5 }}>
              The winner gets {selected.size === 1 ? 'the NFT' : 'every NFT in the batch'} credited to their BIDit
              account the moment the auction ends, and you're paid 95% instantly.
            </p>
            {err && <div className="auth__error">{err}</div>}
            <div className="acct-actions">
              <button className="btn btn-primary" onClick={startAuction} disabled={busy || !startBid.trim()}>
                {busy ? 'Starting…' : 'Start the auction'}
              </button>
              <button className="btn btn-ghost" onClick={() => setAuctionOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
