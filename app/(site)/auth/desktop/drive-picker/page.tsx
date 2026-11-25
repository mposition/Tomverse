import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { LanguageProvider } from "@/components/LanguageProvider";
import { DOCUMENT_LANGUAGE_HEADER, isSupportedDocumentLanguage } from "@/lib/documentLanguage";
import { desktopDriveEnabled } from "@/lib/nativeBearerGate";
import { readGooglePickerConfig } from "@/lib/googleDrivePickerConfig";
import { DrivePickerPage } from "./DrivePickerPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Google Drive · Tomverse Desktop", robots: { index: false, follow: false }, referrer: "strict-origin" };

export default async function Page() {
  const config = readGooglePickerConfig();
  if (!desktopDriveEnabled() || !config) notFound();
  const language = (await headers()).get(DOCUMENT_LANGUAGE_HEADER);
  return <LanguageProvider initialLang={isSupportedDocumentLanguage(language) ? language : "en"} forceInitialLang>
    <DrivePickerPage config={config} />
  </LanguageProvider>;
}
