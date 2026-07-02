export interface LiveAuction {
  id: string;
  seller: string;
  avatarHue: number;
  title: string;
  category: string;
  tag: string;
  viewers: number;
  currentBid: number;
  image: string;
  hot?: boolean;
}

const img = (id: string) => `https://images.pokemontcg.io/${id}_hires.png`;

export const FEATURED: LiveAuction[] = [
  { id: '1', seller: 'kanto_kid', avatarHue: 150, title: 'Base Set Charizard — raw rips & singles', category: 'Pokémon', tag: 'Vintage', viewers: 1284, currentBid: 64, image: img('base1/4'), hot: true },
  { id: '2', seller: 'grandline_gg', avatarHue: 14, title: 'One Piece OP-09 case break — alt arts', category: 'One Piece', tag: 'Sealed', viewers: 873, currentBid: 38, image: img('base1/2') },
  { id: '3', seller: 'slabsquad', avatarHue: 265, title: 'PSA 10 slab showdown — $1 starts', category: 'Graded Slabs', tag: '$1 start', viewers: 642, currentBid: 21, image: img('base1/10') },
  { id: '4', seller: 'mintkingtcg', avatarHue: 205, title: 'Evolving Skies ETB rip & ship', category: 'Pokémon', tag: 'Modern', viewers: 1530, currentBid: 52, image: img('base1/15'), hot: true },
  { id: '5', seller: 'whale_breaks', avatarHue: 320, title: 'NBA Prizm hobby box — random teams', category: 'Sports Cards', tag: 'Breaks', viewers: 410, currentBid: 17, image: img('base1/6') },
  { id: '6', seller: 'frostbyte', avatarHue: 95, title: 'Umbreon VMAX chase — wheel spin', category: 'Pokémon', tag: 'Wheel', viewers: 980, currentBid: 45, image: img('base1/14') },
];

export const CATEGORIES = [
  { name: 'One Piece', glyph: '🏴‍☠️', soft: '#fdeceb', ink: '#c0392b' },
  { name: 'Pokémon', glyph: '⚡', soft: '#fdf4dc', ink: '#a9760a' },
  { name: 'Sports Cards', glyph: '🏀', soft: '#e8f0fd', ink: '#2563c0' },
  { name: 'Sealed & Boxes', glyph: '📦', soft: '#e7f5ef', ink: '#0a7d56' },
  { name: 'Graded Slabs', glyph: '💎', soft: '#e6f4fb', ink: '#1f7fb0' },
  { name: 'Mystery & Breaks', glyph: '🎲', soft: '#f1ecfd', ink: '#6b46c1' },
];

/** Interest options shown during onboarding. */
export const INTERESTS = [
  { id: 'one-piece', label: 'One Piece', glyph: '🏴‍☠️' },
  { id: 'pokemon', label: 'Pokémon', glyph: '⚡' },
  { id: 'sports', label: 'Sports Cards', glyph: '🏀' },
  { id: 'sealed', label: 'Sealed & Boxes', glyph: '📦' },
  { id: 'slabs', label: 'Graded Slabs', glyph: '💎' },
  { id: 'breaks', label: 'Breaks & Rips', glyph: '🎲' },
  { id: 'vintage', label: 'Vintage', glyph: '🕰️' },
  { id: 'modern', label: 'Modern Chase', glyph: '✨' },
  { id: 'magic', label: 'Magic: The Gathering', glyph: '🧙' },
];

export const WINS = [
  { who: 'luna_degen', item: 'Charizard — Base Set', amt: 64 },
  { who: 'degen_max', item: 'Umbreon ex — SIR', amt: 128 },
  { who: 'kanto_kid', item: 'OP-09 Luffy Alt Art', amt: 91 },
  { who: 'slabsquad', item: 'PSA 10 Blastoise', amt: 240 },
  { who: 'mintking', item: 'Evolving Skies ETB', amt: 47 },
  { who: 'apex_whale', item: 'Prizm Wemby RC', amt: 310 },
];
