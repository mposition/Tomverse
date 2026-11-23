"use client";

import { createContext, useContext, type ReactNode } from "react";

const StudioAvailability = createContext(false);

export function StudioAvailabilityProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <StudioAvailability.Provider value={enabled}>{children}</StudioAvailability.Provider>;
}

export function useStudioAvailable() {
  return useContext(StudioAvailability);
}
