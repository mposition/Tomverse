import { notFound } from "next/navigation";
import { MobileCallbackContent } from "./MobileCallbackContent";

export const dynamic = "force-dynamic";
export default function MobileCallbackPage() {
  if (process.env.TOMVERSE_NATIVE_CHAT_ENABLED !== "true") notFound();
  return <MobileCallbackContent />;
}
