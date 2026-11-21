import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "@/components/LanguageProvider";
import type { Language } from "@/lib/language";

/**
 * Server-side markup of a client component inside the language context.
 * Lives here (a module under the same loader as the components) so the test
 * and the component share one LanguageProvider instance; a test file that
 * imported the provider itself would get a second one and its `useLanguage`
 * would find no context.
 */
export const renderWithLanguage = (element: ReactElement, lang: Language = "ko") =>
    renderToStaticMarkup(
        <LanguageProvider initialLang={lang} forceInitialLang>
            {element}
        </LanguageProvider>
    );
