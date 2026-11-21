import { LanguageProvider } from "@/components/LanguageProvider";
import { CursorGuidePage } from "@/components/marketing/v2/cursor/CursorGuidePage";
import { cursorGuideSeo } from "@/components/marketing/v2/cursor/cursorGuideContent";
import { CURSOR_GUIDE_PATH } from "@/lib/marketingRoutes";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: cursorGuideSeo.en.title,
  description: cursorGuideSeo.en.description,
  path: CURSOR_GUIDE_PATH,
  localizedBasePath: CURSOR_GUIDE_PATH,
});

export default function Page() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <CursorGuidePage />
    </LanguageProvider>
  );
}
