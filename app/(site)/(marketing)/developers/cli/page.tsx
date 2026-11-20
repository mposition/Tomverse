import { LanguageProvider } from "@/components/LanguageProvider";
import { CliPage } from "@/components/marketing/v2/cli/CliPage";
import { cliPageSeo } from "@/components/marketing/v2/cli/cliPageContent";
import { CLI_DOWNLOAD_PATH } from "@/lib/marketingRoutes";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: cliPageSeo.en.title,
  description: cliPageSeo.en.description,
  path: CLI_DOWNLOAD_PATH,
  localizedBasePath: CLI_DOWNLOAD_PATH,
});

export default function Page() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <CliPage />
    </LanguageProvider>
  );
}
