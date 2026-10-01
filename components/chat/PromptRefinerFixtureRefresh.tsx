"use client";

import { useRouter } from "next/navigation";

/** Rendered only behind the server's loopback E2E gate and a test-only cookie. */
export function PromptRefinerFixtureRefresh({ mode }: { mode: "off" | "e2e_fixture" }) {
  const router = useRouter();
  return (
    <button
      type="button"
      hidden
      data-testid="prompt-refiner-fixture-refresh"
      data-mode={mode}
      onClick={() => router.refresh()}
    />
  );
}
