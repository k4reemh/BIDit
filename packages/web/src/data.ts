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
  { name: 'Pokémon', image: 'https://images.unsplash.com/photo-1607435097405-db48f377bff6?w=600&q=80&auto=format&fit=crop' },
  { name: 'One Piece', image: 'https://images.unsplash.com/photo-1612036782180-6f0b6cd846fe?w=600&q=80&auto=format&fit=crop' },
  { name: 'Sports Cards', image: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?w=600&q=80&auto=format&fit=crop' },
  { name: 'Sealed & Boxes', image: 'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=600&q=80&auto=format&fit=crop' },
  { name: 'Graded Slabs', image: 'https://images.unsplash.com/photo-1608889825205-eebdb9fc5806?w=600&q=80&auto=format&fit=crop' },
  { name: 'Mystery & Breaks', image: 'https://images.unsplash.com/photo-1595246140625-573b715d11dc?w=600&q=80&auto=format&fit=crop' },
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
