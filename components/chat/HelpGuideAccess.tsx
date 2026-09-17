"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * HELP-NAV-01. Which of the help guide's flags are on, resolved on the server
 * for this request (ReviewWorkspaceShell) and read by the guide dialog.
 *
 * A Client Component cannot read AppSetting rows itself, and a copy baked in at
 * build time would keep describing a feature an operator has since switched.
 * Without a provider every flag reads as off, so the guide says "not available
 * right now" rather than offering something that may not exist.
 */
const HelpGuideAccessContext = createContext<ReadonlySet<string>>(new Set());

export function HelpGuideAccessProvider({
  enabledFlagKeys,
  children,
}: {
  enabledFlagKeys: readonly string[];
  children: ReactNode;
}) {
  const value = useMemo(() => new Set(enabledFlagKeys), [enabledFlagKeys]);
  return <HelpGuideAccessContext.Provider value={value}>{children}</HelpGuideAccessContext.Provider>;
}

export const useHelpGuideEnabledFlagKeys = () => useContext(HelpGuideAccessContext);
