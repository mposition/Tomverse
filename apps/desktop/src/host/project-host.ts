import { readFile } from "node:fs/promises";
import { dialog, type BrowserWindow } from "electron";
import { desktopProjectInput, type DesktopProjectOutcome } from "../project-contract";
import type { Language } from "../../../../lib/language";
import { projectWorkspaceCopy } from "../../../../locales/projectWorkspace";
import type { AccountSettingsApi } from "./account-settings-api";
import { createProjectRunner, pickMaterialFiles, type ProjectRunner } from "./project-api";

type SaveLoad = () => Promise<{ bytes: Uint8Array; suggestedName: string; extension: string }>;

/**
 * The `desktop:projects` IPC handler. main.ts supplies the account-session accessor, the main
 * window and its save-file helper; the runner is rebuilt whenever the account session changes so a
 * signed-out account's session is never reused.
 */
export function createProjectActions(deps: {
  settings(): AccountSettingsApi;
  origin(): string;
  window(): BrowserWindow | null;
  language(): Language;
  saveFile(load: SaveLoad, title: string, filterName: string): Promise<boolean>;
  saveTitle(): string;
}) {
  let current: { settings: AccountSettingsApi; origin: string; run: ProjectRunner } | undefined;
  return async function projects(value: unknown): Promise<DesktopProjectOutcome> {
    const input = desktopProjectInput.parse(value);
    const settings = deps.settings();
    const origin = deps.origin();
    if (current?.settings !== settings || current.origin !== origin) {
      const copy = () => projectWorkspaceCopy[deps.language()].materials.upload;
      current = {
        settings, origin,
        run: createProjectRunner(settings, origin, {
          chooseMaterialFiles: () => {
            const window = deps.window();
            return pickMaterialFiles({
              title: copy(), filterName: copy(), readFile,
              showOpenDialog: (options) => window && !window.isDestroyed() ? dialog.showOpenDialog(window, options) : Promise.resolve({ canceled: true, filePaths: [] }),
            });
          },
          saveMaterial: (load) => deps.saveFile(load, deps.saveTitle(), "*"),
        }),
      };
    }
    return current.run(input);
  };
}
