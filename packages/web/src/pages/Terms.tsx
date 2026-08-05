import { Link } from 'react-router-dom';

/**
 * Terms of Service. Static and versioned by date. Every operational claim in
 * here mirrors what the code actually does (escrow flow, dispute window, hold
 * periods, fees), because a term that contradicts the product is unenforceable
 * AND embarrassing. When behaviour changes, this page changes with it.
 */
export default function Terms() {
  return (
    <main className="container legal">
      <h1 className="display">Terms of Service</h1>
      <p className="muted legal__date">Effective August 5, 2026</p>

      <div className="legal__warn">
        <b>BIDit is beta software, and USDC balances are crypto assets, not bank deposits.</b>{' '}
        BIDit is not a bank, licensed money services business, money transmitter, securities dealer,
        or exchange, and balances held on BIDit are not insured by CDIC, FDIC, or any other deposit
        insurance. Do not deposit more than you can afford to lose.
      </div>

      <h2>1. Who we are and what this is</h2>
      <p>
        BIDit (&ldquo;BIDit&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) operates www.biditsol.com, a live-auction
        marketplace where independent sellers auction collectibles and other goods during pump.fun
        livestreams, settled in USDC on the Solana blockchain. These Terms are a binding agreement
        between you and BIDit. By creating an account, depositing funds, bidding, buying, or selling,
        you accept them. If you do not accept them, do not use BIDit.
      </p>

      <h2>2. Beta status</h2>
      <p>
        BIDit is in beta. The service is provided <b>as is</b> and <b>as available</b>. Features may
        change, break, or be removed without notice; downtime, bugs, incorrect displays, mispriced
        estimates, and data loss are possible. We may wipe, migrate, or reset non-financial data
        during the beta. You use BIDit with the understanding that it is early software operated by a
        small team.
      </p>

      <h2>3. Eligibility</h2>
      <ul>
        <li>You must be at least 18 years old and legally able to enter contracts.</li>
        <li>
          You may not use BIDit if you are located in, or a resident of, a jurisdiction where use of
          cryptocurrency marketplaces is prohibited, or if you are subject to Canadian, US, or other
          applicable sanctions.
        </li>
        <li>You are responsible for ensuring BIDit is legal to use where you live.</li>
      </ul>

      <h2>4. Custody, deposits, and the nature of your balance</h2>
      <ul>
        <li>
          Depositing USDC credits a balance held in a wallet that BIDit controls (a custodial
          balance). <b>We are not licensed or regulated as a custodian, bank, or money services
          business in any jurisdiction.</b> Your balance is an unsecured claim against BIDit, not a
          deposit, and is not insured or guaranteed by anyone.
        </li>
        <li>
          Blockchain transactions are irreversible. USDC sent to a wrong address, an unsupported
          network, or a mistyped destination is unrecoverable, and we cannot reverse, refund, or
          retrieve it.
        </li>
        <li>
          To the maximum extent permitted by law, <b>we are not liable for loss of funds</b>,
          including losses caused by software bugs, hacks or exploits, private-key compromise,
          blockchain or network failures, stablecoin de-pegging, third-party failures (including
          Solana, Circle, RPC providers, or pump.fun), our own errors or negligence, or the
          suspension or termination of the service. During the beta, keep balances small and
          withdraw what you are not actively using.
        </li>
        <li>
          Withdrawals are subject to velocity limits, security review, and network conditions, and
          may be delayed or declined where we suspect fraud or abuse.
        </li>
      </ul>

      <h2>5. Auctions, bids, and purchases</h2>
      <ul>
        <li><b>Every bid is a binding offer to buy.</b> Do not bid on items you do not intend to pay for.</li>
        <li>
          When you win an auction or buy from a shop, the sale amount moves from your balance into
          escrow (or to the seller, depending on the mode in effect). Escrowed funds are released to
          the seller after delivery plus a dispute window, when you confirm receipt, or as otherwise
          described in the product.
        </li>
        <li>
          If a seller fails to ship within the required window after you pay for shipping, the sale
          is refunded to your balance. If you choose to discard a won item, you forfeit it and the
          payment goes to the seller.
        </li>
        <li>
          Randomizer (&ldquo;wheel&rdquo;) auctions award a prize selected by our server-side
          randomizer. The recorded result is final. Randomizers are games of chance for
          entertainment; where prize draws are restricted in your jurisdiction, do not participate.
        </li>
        <li>
          We may cancel auctions, void results, and reverse balances affected by bugs, manipulation,
          or fraud. Manipulated or bugged outcomes are not honoured.
        </li>
      </ul>

      <h2>6. Sellers</h2>
      <ul>
        <li>
          Sellers are independent parties. BIDit is a marketplace and escrow facilitator, not the
          seller of listed items, and we do not authenticate, inspect, or guarantee items unless
          explicitly stated. A &ldquo;Verified&rdquo; badge reflects fulfillment history on BIDit,
          not authentication of goods.
        </li>
        <li>
          Sellers must accurately describe items, own what they list, and ship sold items within the
          required window. Counterfeit, stolen, recalled, or illegal items, and items that infringe
          third-party rights, are prohibited.
        </li>
        <li>
          Sellers are responsible for their own taxes, and for complying with the laws that apply to
          their sales, including customs declarations on international shipments.
        </li>
        <li>
          We may remove listings, hide streams, withhold payouts connected to suspected fraud, and
          suspend seller accounts at our discretion.
        </li>
      </ul>

      <h2>7. Shipping</h2>
      <ul>
        <li>
          Shipping estimates shown before checkout are approximate. The exact shipping price is
          quoted when you pay for shipping, and you are charged exactly the quoted amount.
        </li>
        <li>
          We are still tuning shipping prices during the beta. If a charge is clearly wrong, contact
          us on X at @biditsol: we refund overcharges, and in rare cases of severe undercharge we may
          contact you or the seller about the difference.
        </li>
        <li>
          International shipments are sent <b>Delivered Duty Unpaid</b>: you are responsible for any
          import duties, taxes, or customs fees charged by the carrier or your government on
          delivery.
        </li>
        <li>
          Private Secure Shipping routes your item through BIDit so the seller never sees your name
          or address. It adds a privacy fee and a second shipping leg, which takes longer.
        </li>
        <li>
          Carriers, not BIDit, transport packages. We are not liable for carrier delays, loss, or
          damage in transit beyond the remedies described in the product.
        </li>
      </ul>

      <h2>8. Fees</h2>
      <p>
        BIDit charges a platform fee on sales, shipping fees, and optional service fees (such as the
        privacy fee), each shown in the product at the time you incur them. Fees may change during
        the beta; changes apply to future transactions, never retroactively.
      </p>

      <h2>9. BIDit Points and $BID</h2>
      <ul>
        <li>
          BIDit Points are a promotional feature. <b>They have no monetary value</b>, are not
          redeemable for cash, confer no ownership, equity, profit share, or expectation of profit,
          and may be modified, reset, or discontinued at any time without compensation.
        </li>
        <li>
          $BID is a memecoin on pump.fun. We do not issue, sell, or promise anything with respect to
          it. Any buyback activity is discretionary and may stop at any time. Nothing on BIDit is an
          offer of securities or investment advice, and no BIDit feature should be relied on as an
          investment.
        </li>
      </ul>

      <h2>10. Prohibited conduct</h2>
      <p>
        No fraud, shill bidding or bid manipulation, money laundering, sanctions evasion, exploiting
        bugs (report them instead), scraping or overloading the service, harassment in chat,
        circumventing bans, or using BIDit for any illegal purpose. We may suspend or terminate
        accounts, cancel transactions, and withhold suspect balances pending investigation.
      </p>

      <h2>11. Disclaimers and limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW: THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; WITHOUT
        WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
        PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE ARE NOT LIABLE FOR ANY INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DATA, OR
        LOSS OF CRYPTOASSETS. OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATING
        TO THE SERVICE IS LIMITED TO THE GREATER OF (A) US$100 AND (B) THE FEES YOU PAID TO BIDIT IN
        THE THREE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM. SOME JURISDICTIONS DO NOT ALLOW
        CERTAIN EXCLUSIONS, SO PARTS OF THIS SECTION MAY NOT APPLY TO YOU.
      </p>

      <h2>12. Indemnity</h2>
      <p>
        You will indemnify and hold BIDit and its operators harmless from claims, damages, and
        expenses (including reasonable legal fees) arising from your use of the service, your
        listings or sales, your breach of these Terms, or your violation of any law or third-party
        right.
      </p>

      <h2>13. Termination</h2>
      <p>
        You can stop using BIDit at any time and request account erasure from your settings. We may
        suspend or terminate accounts that break these Terms. On termination we will make reasonable
        efforts to let you withdraw a remaining balance not connected to fraud or an open dispute.
      </p>

      <h2>14. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of the Province of Alberta and the federal laws of
        Canada applicable there. Courts located in Alberta have exclusive jurisdiction, and you and
        BIDit each waive any right to a class action to the extent permitted by law. Before filing
        anything, contact us: most problems are fixable in a day.
      </p>

      <h2>15. Changes</h2>
      <p>
        We may update these Terms as the beta evolves. The effective date above changes when we do,
        and material changes will be announced in the product or on X. Continuing to use BIDit after
        a change means you accept it.
      </p>

      <h2>16. Contact</h2>
      <p>
        X / Twitter: <a href="https://x.com/biditsol" target="_blank" rel="noreferrer">@biditsol</a>.
        See also the <Link to="/privacy">Privacy Policy</Link> and <Link to="/docs">Docs</Link>.
      </p>
    </main>
  );
}
