/**
 * Editable site copy. Components read strings via useCopy() → t('key'), which
 * returns the admin override (fetched from the backend) or the DEFAULT below.
 * FIELDS drives the /admin/content editor. Add a key here + use t('key') in a
 * component to make any new string editable.
 */
export interface Field {
  key: string;
  label: string;
  group: string;
  multiline?: boolean;
}

export const FIELDS: Field[] = [
  // Homepage
  { key: 'home.hero.tag', label: 'Hero badge', group: 'Homepage' },
  { key: 'home.hero.title', label: 'Hero headline', group: 'Homepage' },
  { key: 'home.hero.sub', label: 'Hero subtitle', group: 'Homepage', multiline: true },
  { key: 'home.hero.ctaPrimary', label: 'Primary button', group: 'Homepage' },
  { key: 'home.hero.ctaSecondary', label: 'Secondary button', group: 'Homepage' },
  { key: 'home.trust.1', label: 'Trust chip 1', group: 'Homepage' },
  { key: 'home.trust.2', label: 'Trust chip 2', group: 'Homepage' },
  { key: 'home.trust.3', label: 'Trust chip 3', group: 'Homepage' },
  { key: 'home.live.title', label: 'Live section title', group: 'Homepage' },
  { key: 'home.live.sub', label: 'Live section subtitle', group: 'Homepage' },
  // Help
  { key: 'help.hero.tag', label: 'Help badge', group: 'Help page' },
  { key: 'help.hero.title', label: 'Help headline', group: 'Help page' },
  { key: 'help.hero.lead', label: 'Help intro', group: 'Help page', multiline: true },
  // Docs
  { key: 'docs.hero.title', label: 'Docs headline', group: 'Docs page' },
  { key: 'docs.hero.lead', label: 'Docs intro', group: 'Docs page', multiline: true },
  // Footer
  { key: 'footer.blurb', label: 'Footer blurb', group: 'Footer', multiline: true },
];

export const DEFAULTS: Record<string, string> = {
  'home.hero.tag': 'Now live in beta',
  'home.hero.title': 'The live marketplace for trading cards.',
  'home.hero.sub':
    'Bid in real time on the Pokémon, One Piece and sports breaks streaming on pump.fun. Win it, we ship it, and you settle in USDC.',
  'home.hero.ctaPrimary': "Start bidding — it's free",
  'home.hero.ctaSecondary': 'Browse live auctions',
  'home.trust.1': 'Settles in USDC',
  'home.trust.2': 'Built on Solana',
  'home.trust.3': '5% of sales buy back $BID',
  'home.live.title': 'Live right now',
  'home.live.sub': 'Watch the stream and bid — right here, no extension needed.',
  'help.hero.tag': 'Help & quick start',
  'help.hero.title': 'Everything you need to get going.',
  'help.hero.lead':
    'New to BIDit? Follow the steps below. Want the full picture — escrow, fees, the $BID flywheel — the docs cover it all.',
  'docs.hero.title': 'How BIDit works',
  'docs.hero.lead':
    'BIDit turns a live pump.fun stream into a real trading-card auction house. Sellers run live auctions straight on their stream, bidders bid in USDC from a funded balance, cards are held until they ship, and 5% of every shipped sale buys back $BID on-chain.',
  'footer.blurb':
    'The live card auction that lives on the streams you already watch. Win it, we ship it, 5% pumps $BID.',
};
