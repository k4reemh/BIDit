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

/** Category tiles — real imagery (Whatnot-style), no emoji. */
export const CATEGORIES = [
  { name: 'Pokémon', image: '/categories/pokemon.jpg' },
  { name: 'One Piece', image: '/categories/one-piece.jpg' },
  { name: 'Sports Cards', image: '/categories/sports-cards.jpg' },
  { name: 'Sealed Items', image: '/categories/sealed.jpg' },
  { name: 'Technology', image: '/categories/technology.jpg' },
  { name: 'Clothes', image: '/categories/clothes.jpg' },
];

/** Interest options shown during onboarding (labels only — no emoji). */
export const INTERESTS = [
  { id: 'pokemon', label: 'Pokémon' },
  { id: 'one-piece', label: 'One Piece' },
  { id: 'sports', label: 'Sports Cards' },
  { id: 'sealed', label: 'Sealed & Boxes' },
  { id: 'slabs', label: 'Graded Slabs' },
  { id: 'breaks', label: 'Breaks & Rips' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'modern', label: 'Modern Chase' },
  { id: 'magic', label: 'Magic: The Gathering' },
];

export const WINS = [
  { who: 'luna_degen', item: 'Charizard — Base Set', amt: 64 },
  { who: 'degen_max', item: 'Umbreon ex — SIR', amt: 128 },
  { who: 'kanto_kid', item: 'OP-09 Luffy Alt Art', amt: 91 },
  { who: 'slabsquad', item: 'PSA 10 Blastoise', amt: 240 },
  { who: 'mintking', item: 'Evolving Skies ETB', amt: 47 },
  { who: 'apex_whale', item: 'Prizm Wemby RC', amt: 310 },
];
