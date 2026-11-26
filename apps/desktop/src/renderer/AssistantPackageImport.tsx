import { createContext, useContext, useMemo, type ReactNode } from "react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ModelCatalogProvider } from "@/components/ModelCatalogProvider";
import { AssistantPackageImportWizard, type AssistantPackageImportHost } from "@/components/assistants/import/AssistantPackageImportWizard";
import { createDesktopImportRequests, pickDesktopPackage, type AssistantImportCall } from "./assistant-import-requests";
import { dictionaries, ReadStatus, useSettingsRead, type Common } from "./settings-shared";
import "./assistant-package-import.css";

// Importing an assistant package: the web's own wizard, with the requests and the file dialog
// answered by the main process. Every step, in the web's order, is the wizard's; this file only
// supplies where bytes and requests go.

const call: AssistantImportCall = input => window.desktop.assistantImport(input);
const requests = createDesktopImportRequests(call);

async function loadTargets() {
  const result = await window.desktop.assistantImport<"targets">({ action: "targets" });
  if (!result.ok) throw new Error("Assistant import is unavailable.");
  return result.value;
}
const loadModels = () => window.desktop.chatModels();

/** Offered exactly when the server has the import on, which is when the web offers it. */
export function AssistantPackageImportEntry({ language, onOpen }: Common & { onOpen(): void }) {
  const state = useSettingsRead(loadTargets);
  if (!state.data?.enabled) return null;
  return <button type="button" className="soft" data-testid="native-assistant-import" onClick={onOpen}>
    {dictionaries[language].assistantProfiles.importPackage}
  </button>;
}

const CloseImport = createContext<() => void>(() => {});

function DoneButton({ className, children, ...rest }: { className: string; "data-testid": string; children: ReactNode }) {
  const close = useContext(CloseImport);
  return <button type="button" className={className} data-testid={rest["data-testid"]} onClick={close}>{children}</button>;
}

export function AssistantPackageImportPanel({ language, close }: Common & { close(): void }) {
  const targets = useSettingsRead(loadTargets);
  // The live catalogue the main process already reads; the wizard falls back to the built-in list without it.
  const models = useSettingsRead(loadModels);
  const copy = dictionaries[language].assistantProfiles;
  const host = useMemo<AssistantPackageImportHost>(() => ({
    requests,
    pickPackage: () => pickDesktopPackage(call),
    header: <button type="button" className="soft" data-testid="native-assistant-import-back" onClick={close}>{copy.backToList}</button>,
    DoneLink: DoneButton,
    // The web re-reads its page after letting go of a staged import; nothing here lists them.
    refresh: () => {},
    // There is no list of staged imports to come back to, so closing the wizard lets go of one.
    cancelOnLeave: true,
  }), [close, copy.backToList]);
  if (!targets.data || (!models.data && !models.failed)) {
    return <ReadStatus language={language} failed={targets.failed} retry={targets.reload} />;
  }
  return <div className="assistant-package-import" data-testid="native-assistant-import-panel">
    <LanguageProvider initialLang={language} forceInitialLang>
      <ModelCatalogProvider initialModels={models.data} live={false}>
        <CloseImport.Provider value={close}>
          <AssistantPackageImportWizard mergeTargets={targets.data.targets} host={host} />
        </CloseImport.Provider>
      </ModelCatalogProvider>
    </LanguageProvider>
  </div>;
}
