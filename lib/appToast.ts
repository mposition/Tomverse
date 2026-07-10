export type AppToastTone = "success" | "error" | "info";

export type AppToastEventDetail = {
  message: string;
  tone?: AppToastTone;
};

export const APP_TOAST_EVENT = "tomverse:toast";

export const dispatchAppToast = (
  message: string,
  tone: AppToastTone = "info"
) => {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent<AppToastEventDetail>(APP_TOAST_EVENT, {
      detail: { message, tone },
    })
  );
};
