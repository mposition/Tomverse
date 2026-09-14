import { notFound } from "next/navigation";

import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { PromptRefinerFocusHarness } from "./PromptRefinerFocusHarness";

export const dynamic = "force-dynamic";

const single = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * Browser-only mount for the Prompt Refiner focus contract. The same
 * loopback-and-two-flags gate as the admin fixture makes this route a 404 on
 * every real deployment; it has no provider, billing or Router connection.
 */
export default async function PromptRefinerFixturePage({
  searchParams,
}: PageProps<"/e2e/prompt-refiner-fixture">) {
  if (!isE2EFixtureMode()) notFound();
  const params = await searchParams;
  return (
    <PromptRefinerFocusHarness
      initialState={single(params.initial) === "ready" ? "ready" : "idle"}
    />
  );
}
