// Shared Enter-key policy for every chat message textarea (main composer and
// the per-model follow-up input). Framework-agnostic so it can be unit
// tested without a DOM: given a keydown event and whether the current chat
// shell is mobile, it says whether Enter should submit the message or fall
// through to the textarea's default newline insertion.
//
// PC shell: Enter submits, Shift+Enter and IME composition never submit.
// Mobile shell: Enter always inserts a newline; only Ctrl/Cmd+Enter submits
// (for users with an external keyboard), and IME composition never submits.
export type ChatEnterKeyEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export type ChatEnterKeyAction = "submit" | "default";

export function getChatEnterKeyAction(
  event: ChatEnterKeyEvent,
  isComposing: boolean,
  isMobileShell: boolean
): ChatEnterKeyAction {
  if (event.key !== "Enter" || isComposing) return "default";

  const hasExternalKeyboardSubmitModifier = event.ctrlKey || event.metaKey;

  if (isMobileShell) {
    return hasExternalKeyboardSubmitModifier ? "submit" : "default";
  }

  if (event.shiftKey) return "default";
  return "submit";
}

// Some mobile browsers (notably older Android WebViews) fire the Enter
// keydown that confirms IME composition with isComposing already false, so
// keyCode 229 is kept as a fallback signal alongside nativeEvent.isComposing.
export function isComposingKeydown(event: {
  nativeEvent?: { isComposing?: boolean };
  keyCode?: number;
}): boolean {
  return Boolean(event.nativeEvent?.isComposing) || event.keyCode === 229;
}
