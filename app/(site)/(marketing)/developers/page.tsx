import { LanguageProvider } from "@/components/LanguageProvider";
import { DevelopersPage } from "@/components/marketing/v2/developers/DevelopersPage";
import { developersPageSeo } from "@/components/marketing/v2/developers/developersPageContent";
import { DEVELOPERS_PATH } from "@/lib/marketingRoutes";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: developersPageSeo.en.title,
  description: developersPageSeo.en.description,
  path: DEVELOPERS_PATH,
  localizedBasePath: DEVELOPERS_PATH,
});

export default function Page() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <DevelopersPage />
    </LanguageProvider>
  );
}
