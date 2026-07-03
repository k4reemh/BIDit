import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getContent } from './api';
import { DEFAULTS } from './content';

const Ctx = createContext<Record<string, string>>(DEFAULTS);

/** Loads admin copy overrides once and merges them over the in-code defaults.
 *  Renders defaults immediately, then swaps in overrides when they arrive. */
export function ContentProvider({ children }: { children: ReactNode }) {
  const [copy, setCopy] = useState<Record<string, string>>(DEFAULTS);
  useEffect(() => {
    getContent()
      .then((overrides) => setCopy({ ...DEFAULTS, ...overrides }))
      .catch(() => {});
  }, []);
  return <Ctx.Provider value={copy}>{children}</Ctx.Provider>;
}

/** t('some.key') → the admin override, or the in-code default. */
export function useCopy() {
  const copy = useContext(Ctx);
  return (key: string) => copy[key] ?? DEFAULTS[key] ?? key;
}
