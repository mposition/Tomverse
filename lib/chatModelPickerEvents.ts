// Lets a control outside the composer (the mobile header's model summary) open
// the existing "Choose AI models" picker instead of duplicating it. Mirrors the
// modelFinderEvents.ts pattern; the picker already renders as a full-screen
// sheet on mobile, so it does not need to be anchored to its usual trigger.
export const CHAT_MODEL_PICKER_OPEN_EVENT = "tomverse:chat-model-picker-open";

export type ChatModelPickerOpenDetail = {
  /** Focus goes back here when the picker closes. */
  trigger?: HTMLElement | null;
};

export const openChatModelPicker = (trigger?: HTMLElement | null) => {
  window.dispatchEvent(
    new CustomEvent<ChatModelPickerOpenDetail>(CHAT_MODEL_PICKER_OPEN_EVENT, {
      detail: { trigger: trigger ?? null },
    })
  );
};

// Sent by the composer when the picker closes for any reason (pick, dismiss,
// Escape, outside click). A control that opened the picker for one purpose,
// such as "Try another model", uses it to end its wait instead of leaving it
// live for the rest of its timeout.
export const CHAT_MODEL_PICKER_CLOSED_EVENT = "tomverse:chat-model-picker-closed";

export const notifyChatModelPickerClosed = () => {
  window.dispatchEvent(new CustomEvent(CHAT_MODEL_PICKER_CLOSED_EVENT));
};
