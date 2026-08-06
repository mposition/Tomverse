"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { ADMIN_SEARCHABLE_PAGES } from "@/lib/adminNavigation";

/**
 * Per-operator console preferences: pinned pages and recently visited routes.
 *
 * One store, one provider, so the sidebar's "Quick access" list, the command
 * palette and the Overview panel cannot disagree about what is pinned. The
 * previous "Saved views" panel wrote `tomverse-admin-default-view` that nothing
 * ever read -- pressing "Set default" changed no entry point and no navigation,
 * so the control reported a preference the console did not have. Pinning is the
 * same gesture with an effect that is visible in two places immediately.
 */

const PINNED_STORAGE_KEY = "tomverse-admin-pinned-pages";
const RECENT_STORAGE_KEY = "tomverse-admin-recent-routes";
const RECENT_LIMIT = 6;
const PINNED_LIMIT = 12;

/**
 * What a console with no stored preference starts with.
 *
 * Seeded rather than empty so the feature is visible on a first visit, and
 * persisted on that first read so removing every pin is a decision that sticks
 * instead of being undone by the next page load.
 */
const DEFAULT_PINNED = [
  "/admin/work-queue",
  "/admin/refunds",
  "/admin/providers",
] as const;

const KNOWN_HREFS = new Set(ADMIN_SEARCHABLE_PAGES.map((page) => page.href));

type PreferencesValue = {
  pinned: string[];
  recent: string[];
  isPinned: (href: string) => boolean;
  togglePin: (href: string) => void;
  /** False until the browser store has been read, so nothing flashes. */
  ready: boolean;
  pinLimit: number;
};

const AdminConsolePreferencesContext = createContext<PreferencesValue | null>(null);

const readStringArray = (key: string): string[] | null => {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // Private browsing and storage policies both surface here. Preferences are
    // a convenience; the console works without them.
    return null;
  }
};

const writeStringArray = (key: string, value: string[]) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // As above: persistence is best-effort.
  }
};

export function AdminConsolePreferencesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [pinned, setPinned] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStringArray(PINNED_STORAGE_KEY);
    let next: string[];
    if (stored === null) {
      next = [...DEFAULT_PINNED];
      writeStringArray(PINNED_STORAGE_KEY, next);
    } else {
      // A pin for a route that no longer exists would render a dead link in the
      // sidebar, so unknown hrefs are dropped on read rather than on click.
      next = stored.filter((href) => KNOWN_HREFS.has(href)).slice(0, PINNED_LIMIT);
    }
    // Deferred past the commit, like every other browser-store read in the
    // console: the server cannot produce this value, so writing it during the
    // effect body would be a cascading render for a value the first paint never
    // had.
    queueMicrotask(() => {
      setPinned(next);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const stored = readStringArray(RECENT_STORAGE_KEY) || [];
    const next = [pathname, ...stored.filter((item) => item !== pathname)].slice(
      0,
      RECENT_LIMIT
    );
    // Deferred past the commit: the server never produces this value, so a read
    // during render would give the two renders different content.
    queueMicrotask(() => setRecent(next));
    writeStringArray(RECENT_STORAGE_KEY, next);
  }, [pathname]);

  const togglePin = useCallback((href: string) => {
    setPinned((current) => {
      const next = current.includes(href)
        ? current.filter((item) => item !== href)
        : [...current, href].slice(0, PINNED_LIMIT);
      writeStringArray(PINNED_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo<PreferencesValue>(
    () => ({
      pinned,
      recent,
      ready,
      pinLimit: PINNED_LIMIT,
      isPinned: (href: string) => pinned.includes(href),
      togglePin,
    }),
    [pinned, recent, ready, togglePin]
  );

  return (
    <AdminConsolePreferencesContext.Provider value={value}>
      {children}
    </AdminConsolePreferencesContext.Provider>
  );
}

export function useAdminConsolePreferences(): PreferencesValue {
  const value = useContext(AdminConsolePreferencesContext);
  if (!value) {
    throw new Error(
      "useAdminConsolePreferences must be used inside AdminConsolePreferencesProvider."
    );
  }
  return value;
}
