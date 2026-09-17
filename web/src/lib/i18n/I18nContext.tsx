import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { LOCALE_STORAGE_KEY } from '../config.js';
import {
  LOCALES,
  platformMessages,
  type Direction,
  type Locale,
  type Messages,
} from './dictionaries.js';

/**
 * Minimal, dependency-free i18n. RTL is STRUCTURAL: setting the locale updates
 * `<html dir>` and `<html lang>`, and all layout CSS uses logical properties, so
 * the whole app mirrors correctly for Arabic without per-component work.
 *
 * Domain teams register their own namespaced messages (e.g. `clinical.*`) via
 * `registerMessages` so they never edit the platform dictionary.
 */
interface I18nContextValue {
  locale: Locale;
  dir: Direction;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
}

const extra: Record<Locale, Messages> = { en: {}, ar: {} };

/** Merge a domain dictionary into the registry (call at module load). */
export function registerMessages(locale: Locale, messages: Messages): void {
  extra[locale] = { ...extra[locale], ...messages };
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (v === 'en' || v === 'ar') return v;
  } catch {
    /* ignore */
  }
  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(readLocale);
  const dir = LOCALES[locale].dir;

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale);
    document.documentElement.setAttribute('dir', dir);
  }, [locale, dir]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const dict: Messages = { ...platformMessages[locale], ...extra[locale] };
    return {
      locale,
      dir,
      setLocale,
      toggleLocale: () => setLocale(locale === 'en' ? 'ar' : 'en'),
      t: (key, vars) => {
        let str = dict[key] ?? key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return str;
      },
    };
  }, [locale, dir, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}
