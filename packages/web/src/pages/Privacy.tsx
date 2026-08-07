import { Link } from 'react-router-dom';

/**
 * Privacy Policy. Like the Terms, every claim here mirrors what the backend
 * actually does (address encryption at rest, the 90-day shipment-PII purge,
 * the erasure endpoint, what sellers can and cannot see). No invented
 * commitments: promising a practice we don't have is a liability, not cover.
 */
export default function Privacy() {
  return (
    <main className="container legal">
      <h1 className="display">Privacy Policy</h1>
      <p className="muted legal__date">Effective August 5, 2026</p>

      <p>
        This policy explains what BIDit (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects when you use
        www.biditsol.com, what we do with it, and what control you have. Short version: we collect
        what a marketplace needs to run auctions and ship packages, we don&rsquo;t sell your data,
        and we don&rsquo;t run ad trackers.
      </p>

      <h2>1. What we collect</h2>
      <ul>
        <li><b>Account:</b> email address, username, password (stored only as a salted hash, never in plain text), and optional profile details like a bio and avatar.</li>
        <li><b>Shipping:</b> your name, delivery address, and postal code, needed to quote shipping and buy labels. Delivery addresses are encrypted at rest in our database.</li>
        <li><b>Seller details:</b> ship-from address, package sizes and weights for listings, and stream details.</li>
        <li><b>Financial activity:</b> your USDC balance and ledger (deposits, bids, wins, refunds, withdrawals), your deposit wallet address, and the wallet addresses you withdraw to. We never see or store your external wallet&rsquo;s private keys.</li>
        <li><b>Content:</b> chat messages, listings, and dispute messages you submit.</li>
        <li><b>Technical:</b> IP address and basic request logs, used for security, rate limiting, and abuse prevention. We do not use advertising cookies or third-party analytics trackers; your session is kept in a token in your own browser&rsquo;s storage.</li>
      </ul>

      <h2>2. How we use it</h2>
      <p>
        To run the marketplace: operating auctions and escrow, quoting and buying shipping labels,
        sending transactional email (verification codes, password resets, order updates), preventing
        fraud and abuse, complying with legal obligations, and improving the product. We do not sell
        or rent personal information, and we do not use it for third-party advertising.
      </p>

      <h2>3. Who sees your address</h2>
      <ul>
        <li>
          When an item ships to you, the seller receives a shipping label that carries your name and
          delivery address, because a package needs one to arrive.
        </li>
        <li>
          <b>Private Secure Shipping</b> is the exception: the seller ships to BIDit and we re-ship
          to you, so the seller never sees your name or address.
        </li>
        <li>Buyers never see a seller&rsquo;s address, only the region shown on their profile.</li>
      </ul>

      <h2>4. Who we share data with</h2>
      <ul>
        <li><b>Shippo and shipping carriers</b> (USPS, UPS, and others): names, addresses, and parcel details, to quote rates and produce labels, including customs declarations on international shipments.</li>
        <li><b>Resend:</b> your email address, to deliver transactional email.</li>
        <li><b>Hosting and infrastructure</b> (Render, Vercel, and our database provider): all service data lives on their servers, which may be located in the United States.</li>
        <li><b>Solana RPC providers</b> (such as Helius): wallet addresses and transactions, to process deposits and withdrawals.</li>
        <li><b>pump.fun:</b> we read public stream and coin data from them; livestreams and chat happen under their own terms and privacy policy.</li>
        <li><b>Authorities:</b> if legally required, or where necessary to investigate fraud or protect users.</li>
      </ul>

      <h2>5. The blockchain is public</h2>
      <p>
        Deposits and withdrawals are transactions on the Solana blockchain. They are public,
        permanent, and outside our control: anyone can see amounts, timestamps, and wallet
        addresses, and link activity across addresses. Nothing we do can delete or hide on-chain
        history. If that matters to you, use a fresh wallet for BIDit.
      </p>

      <h2>6. Retention and deletion</h2>
      <ul>
        <li>Delivery names and addresses attached to a shipment are automatically purged about 90 days after delivery.</li>
        <li>
          You can delete your account from your settings. This erases your personal information
          (email, addresses, profile) from active systems. We keep what we must: anonymized
          financial ledger entries for the integrity of past transactions, and records needed for
          fraud prevention or legal compliance.
        </li>
        <li>Withdraw your balance before deleting your account; an erased account cannot be recovered.</li>
      </ul>

      <h2>7. Security</h2>
      <p>
        Passwords are hashed, delivery addresses are encrypted at rest, sessions can be revoked, and
        access to production systems is restricted. That said, BIDit is beta software and no system
        is perfectly secure; we cannot guarantee against every breach. If a breach affects your
        data, we will notify affected users as required by law.
      </p>

      <h2>8. Your rights</h2>
      <p>
        You can access and correct your information from your account pages, and delete your account
        yourself. Depending on where you live (including under Canadian PIPEDA and similar laws),
        you may have additional rights to access, correct, or delete personal information, which you
        can exercise by contacting us. We respond to requests as quickly as a small team can.
      </p>

      <h2>9. Age</h2>
      <p>
        BIDit is for adults 18 and over. We do not knowingly collect information from anyone under
        18; if we learn we have, we delete the account.
      </p>

      <h2>10. Changes and contact</h2>
      <p>
        We may update this policy as the beta evolves; the effective date above changes when we do,
        and material changes will be announced in the product or on X. Questions or requests:{' '}
        <a href="https://x.com/biditsol" target="_blank" rel="noreferrer">@biditsol</a> on X. See
        also the <Link to="/terms">Terms of Service</Link>.
      </p>
    </main>
  );
}
