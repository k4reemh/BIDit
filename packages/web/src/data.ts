/** Every category a seller can stream under. The `name` is what sellers pick in
 *  Settings and what /browse?cat= filters on, so renaming one needs a backend
 *  backfill for saved profiles. Order here is the order the browse filters render.
 *
 *  Entries with an `image` also get a photo tile on the homepage and in the
 *  nav dropdown; the rest are filter-only. */
export type Category = { name: string; image?: string };

export const CATEGORIES: Category[] = [
  { name: 'Pokémon', image: '/categories/pokemon.jpg' },
  { name: 'One Piece', image: '/categories/one-piece.jpg' },
  { name: 'Sports Cards', image: '/categories/sports-cards.jpg' },
  { name: 'Sealed Items', image: '/categories/sealed.jpg' },
  { name: 'Comics & Manga', image: '/categories/comics-manga.jpg' },
  { name: 'Video Games' },
  { name: 'Toys & Hobbies' },
  { name: 'Coins & Money' },
  { name: 'Mens Fashion', image: '/categories/mens-fashion.jpg' },
  { name: 'Womens Fashion', image: '/categories/womens-fashion.jpg' },
  { name: 'Sneakers', image: '/categories/sneakers.jpg' },
  { name: 'Bags & Accessories', image: '/categories/bags.jpg' },
  { name: 'Jewelry & Watches', image: '/categories/jewelry-watches.jpg' },
  { name: 'Beauty' },
  { name: 'Technology', image: '/categories/technology.jpg' },
  { name: 'Sporting Goods' },
  { name: 'Books' },
  { name: 'Food & Drink' },
  { name: 'Home & Garden' },
  { name: 'Antiques & Vintage' },
];

/** The eleven photo tiles (homepage grid + nav dropdown). The homepage adds a
 *  twelfth "Browse more" tile after these. */
export const FEATURED_CATEGORIES = CATEGORIES.filter(
  (c): c is Required<Category> => Boolean(c.image),
);

/** Interest options shown during onboarding.
 *
 *  These are the CATEGORIES a seller can stream under, so the answers actually
 *  line up with the live feed they get filtered against. Ids are stable slugs:
 *  renaming a label here must not orphan the interests already saved on accounts. */
export const INTERESTS = CATEGORIES.map((c) => ({
  id: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  label: c.name,
}));
