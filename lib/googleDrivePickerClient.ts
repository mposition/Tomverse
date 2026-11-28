import { driveSelection, googleDriveTypes, type DriveSelection } from "./desktopDrivePickerContract";

const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const loadExternalScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing || document.createElement("script");
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${src}`)),
      { once: true }
    );

    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
  });

export type GooglePickerConfig = {
  clientId: string;
  apiKey: string;
  appId: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
};

interface GooglePickerView {
  setIncludeFolders(value: boolean): GooglePickerView;
  setMimeTypes(value: string): GooglePickerView;
}

interface GooglePickerInstance {
  setVisible(value: boolean): void;
}

interface GooglePickerBuilder {
  setAppId(value: string): GooglePickerBuilder;
  setMaxItems(value: number): GooglePickerBuilder;
  setOAuthToken(value: string): GooglePickerBuilder;
  setDeveloperKey(value: string): GooglePickerBuilder;
  addView(value: GooglePickerView): GooglePickerBuilder;
  enableFeature(value: unknown): GooglePickerBuilder;
  setCallback(
    callback: (data: Record<string, unknown>) => void
  ): GooglePickerBuilder;
  build(): GooglePickerInstance;
}

interface GooglePickerWindow extends Window {
  gapi: {
    load(
      name: string,
      options: { callback: () => void; onerror: () => void }
    ): void;
  };
  google: {
    accounts: {
      oauth2: {
        initTokenClient(config: {
          client_id: string;
          scope: string;
          callback: (response: GoogleTokenResponse) => void;
          error_callback?: () => void;
        }): {
          requestAccessToken(options: { prompt: string }): void;
        };
      };
    };
    picker: {
      DocsView: new (viewId: unknown) => GooglePickerView;
      PickerBuilder: new () => GooglePickerBuilder;
      ViewId: { DOCS: unknown };
      Feature: { MULTISELECT_ENABLED: unknown };
      Response: { ACTION: string; DOCUMENTS: string };
      Action: { PICKED: unknown; CANCEL: unknown };
      Document: { ID: string; NAME: string; MIME_TYPE: string };
    };
  };
}

export const isGooglePickerConfig = (value: unknown): value is GooglePickerConfig => {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.clientId === "string" &&
    typeof config.apiKey === "string" &&
    typeof config.appId === "string"
  );
};


export async function loadGoogleDrivePicker() {
  await Promise.all([
    loadExternalScript("https://accounts.google.com/gsi/client"),
    loadExternalScript("https://apis.google.com/js/api.js"),
  ]);
  const { google, gapi } = window as unknown as GooglePickerWindow;
  await new Promise<void>((resolve, reject) => {
    gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Picker failed to load.")) });
  });
  return (config: GooglePickerConfig, slots: number) => new Promise<DriveSelection | null>((resolve, reject) => {
    const refuse = () => reject(new Error("Google authorization failed."));
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: config.clientId, scope: GOOGLE_DRIVE_SCOPE, error_callback: refuse,
      callback: ({ access_token: accessToken, error }) => {
        if (error || !accessToken) return refuse();
        try {
          const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setIncludeFolders(false).setMimeTypes(googleDriveTypes.join(","));
          const { Response, Action, Document } = google.picker;
          new google.picker.PickerBuilder()
            .setAppId(config.appId).setOAuthToken(accessToken).setDeveloperKey(config.apiKey)
            .addView(view).enableFeature(google.picker.Feature.MULTISELECT_ENABLED).setMaxItems(slots)
            .setCallback((data) => {
              if (data[Response.ACTION] === Action.CANCEL) return resolve(null);
              if (data[Response.ACTION] !== Action.PICKED) return;
              const documents = data[Response.DOCUMENTS];
              const selection = driveSelection.safeParse({ accessToken, files: Array.isArray(documents)
                ? documents.slice(0, slots).map((file) => ({
                    id: file?.[Document.ID], name: file?.[Document.NAME], mimeType: file?.[Document.MIME_TYPE],
                  })) : [] });
              if (selection.success) resolve(selection.data);
              else refuse();
            }).build().setVisible(true);
        } catch { refuse(); }
      },
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });
}
