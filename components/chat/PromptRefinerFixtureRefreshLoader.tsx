"use client";

import dynamic from "next/dynamic";

// A Client boundary is required here: dynamic-importing a Client Component
// directly from the server shell does not enable automatic code splitting.
const FixtureRefresh = dynamic(
  () => import("./PromptRefinerFixtureRefresh").then((mod) => mod.PromptRefinerFixtureRefresh),
  { ssr: false }
);

export function PromptRefinerFixtureRefreshLoader({ mode }: { mode: "off" | "e2e_fixture" }) {
  return <FixtureRefresh mode={mode} />;
}
