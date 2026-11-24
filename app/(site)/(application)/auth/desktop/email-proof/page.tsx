import { notFound } from "next/navigation";
import { desktopAuthEnabled } from "@/lib/desktopAuthServer";
import { DesktopEmailProof } from "./DesktopEmailProof";

export const dynamic = "force-dynamic";

export default function DesktopEmailProofPage() {
  if (!desktopAuthEnabled() || process.env.TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED !== "true") notFound();
  const runtimeEnvironment = process.env;
  return <DesktopEmailProof siteKey={runtimeEnvironment.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />;
}
