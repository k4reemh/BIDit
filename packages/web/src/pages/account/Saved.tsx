import { useAccount } from '../../components/AccountLayout';
import EmptyState from '../../components/EmptyState';
import { Bookmark } from '../../icons';

export default function Saved() {
  useAccount();
  return (
    <>
      <div className="acct-head">
        <h1 className="display acct-title">Saved</h1>
        <p className="muted">Auctions and sellers you bookmarked.</p>
      </div>
      <EmptyState
        icon={Bookmark}
        title="Nothing saved yet"
        sub="Tap the bookmark on any live auction or seller to keep it here for later."
        ctaText="Browse live auctions"
        ctaTo="/"
      />
    </>
  );
}
