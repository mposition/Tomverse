export const GUEST_IMPORT_MODAL_OPEN_EVENT = "tomverse:guest-import-modal-open";

export const openGuestImportModal = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GUEST_IMPORT_MODAL_OPEN_EVENT));
};
