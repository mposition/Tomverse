import { notFound } from "next/navigation";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { MemorySettingsHarness } from "./MemorySettingsHarness";

export const dynamic = "force-dynamic";

/** Local browser mount only; all settings responses are controlled by the test. */
export default function MemorySettingsFixturePage() {
  if (!isE2EFixtureMode()) notFound();
  return <MemorySettingsHarness />;
}
