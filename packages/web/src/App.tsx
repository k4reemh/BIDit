import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import TopNav from './components/TopNav';
import Footer from './components/Footer';
import AuthModal from './components/AuthModal';
import Onboarding from './components/Onboarding';
import AccountLayout from './components/AccountLayout';
import SellerLayout from './components/SellerLayout';
import Home from './pages/Home';
import Docs from './pages/Docs';
import Help from './pages/Help';
import Watch from './pages/Watch';
import StubPage from './pages/StubPage';
import Profile from './pages/account/Profile';
import Shipping from './pages/account/Shipping';
import Deposit from './pages/account/Deposit';
import Saved from './pages/account/Saved';
import Purchases from './pages/account/Purchases';
import ShipItems from './pages/account/ShipItems';
import Bids from './pages/account/Bids';
import SellerOverview from './pages/seller/Overview';
import SellerLive from './pages/seller/Live';
import SellerListings from './pages/seller/Listings';
import SellerShipments from './pages/seller/Shipments';
import SellerOrders from './pages/seller/Orders';
import SellerPayouts from './pages/seller/Payouts';
import SellerSettings from './pages/seller/Settings';
import { restore, clearToken, refreshMe, type Session } from './api';
import { connectBalance } from './realtime';

export interface User {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  following: number;
  followers: number;
  verified: boolean;
  available: string;
  /** Total wallet balance (only drops when the user wins) — shown in the UI. */
  settled: string;
}

export function toUser(s: Session): User {
  return { handle: s.handle, displayName: s.displayName, avatarUrl: s.avatarUrl, following: 0, followers: 0, verified: s.verified, available: s.available, settled: s.settled };
}

const STUBS: Record<string, { title: string; sub: string }> = {
  '/refer': { title: 'Refer friends', sub: 'Invite friends and earn $BID rewards when they bid.' },
  '/friends': { title: 'Friends', sub: 'Find and follow other collectors.' },
  '/settings': { title: 'Account settings', sub: 'Manage your account, security and notifications.' },
  '/account-health': { title: 'Account health', sub: 'Your standing as a buyer and seller on BIDit.' },
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [auth, setAuth] = useState<'signup' | 'signin' | null>(null);
  const [onboarding, setOnboarding] = useState<Session | null>(null);
  const user = session ? toUser(session) : null;

  useEffect(() => {
    restore().then((s) => {
      if (!s) return;
      setSession(s);
      if (!s.onboarded) setOnboarding(s);
    });
  }, []);

  // Live balance over WebSocket — updates the moment a deposit lands, a bid is
  // held/released, or a withdrawal clears. Reconnects on login/logout.
  useEffect(() => {
    if (!session) return;
    return connectBalance((b) =>
      setSession((prev) => (prev ? { ...prev, available: b.available, settled: b.settled } : prev)),
    );
  }, [session?.userId]);

  // Polling fallback: even if a WebSocket push is missed, re-sync the balance
  // every 20s while signed in so deposits/withdrawals always reflect on their own.
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      refreshMe()
        .then((s) => setSession((prev) => (prev ? { ...prev, available: s.available, settled: s.settled } : prev)))
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(id);
  }, [session?.userId]);

  const onAuthed = (s: Session) => {
    setSession(s);
    setAuth(null);
    if (!s.onboarded) setOnboarding(s);
  };

  return (
    <div className="app">
      <div className="shell">
        <TopNav user={user} onAuth={setAuth} onLogout={() => { clearToken(); setSession(null); }} />
        <Routes>
          <Route path="/" element={<Home onAuth={() => setAuth('signup')} />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/help" element={<Help />} />
          <Route path="/live/:coin" element={<Watch session={session} onAuth={() => setAuth('signin')} />} />

          <Route element={<AccountLayout session={session} setSession={setSession} onAuth={() => setAuth('signin')} />}>
            <Route path="/profile" element={<Profile />} />
            <Route path="/shipping" element={<Shipping />} />
            <Route path="/deposit" element={<Deposit />} />
            <Route path="/saved" element={<Saved />} />
            <Route path="/purchases" element={<Purchases />} />
            <Route path="/ship" element={<ShipItems />} />
            <Route path="/bids" element={<Bids />} />
          </Route>

          <Route path="/sell" element={<Navigate to="/seller" replace />} />
          <Route element={<SellerLayout session={session} setSession={setSession} onAuth={() => setAuth('signin')} />}>
            <Route path="/seller" element={<SellerOverview />} />
            <Route path="/seller/live" element={<SellerLive />} />
            <Route path="/seller/listings" element={<SellerListings />} />
            <Route path="/seller/shipments" element={<SellerShipments />} />
            <Route path="/seller/orders" element={<SellerOrders />} />
            <Route path="/seller/payouts" element={<SellerPayouts />} />
            <Route path="/seller/settings" element={<SellerSettings />} />
          </Route>

          {Object.entries(STUBS).map(([path, s]) => (
            <Route key={path} path={path} element={<StubPage title={s.title} sub={s.sub} />} />
          ))}
          <Route path="*" element={<StubPage title="Not found" sub="That page doesn't exist yet." />} />
        </Routes>
        <Footer />
      </div>

      {auth && <AuthModal mode={auth} onClose={() => setAuth(null)} onSuccess={onAuthed} />}
      {onboarding && (
        <Onboarding session={onboarding} onDone={(s) => { setSession(s); setOnboarding(null); }} />
      )}
    </div>
  );
}
