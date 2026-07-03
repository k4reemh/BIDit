import { useState } from 'react';
import { getTheme, toggleTheme, type Theme } from '../theme';
import { Moon, Sun } from '../icons';

/** Light/dark toggle. Dark switches to the Navy Immersive scheme. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const flip = () => setTheme(toggleTheme());
  return (
    <button
      className="icon-btn"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      onClick={flip}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}
