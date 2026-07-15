export const MODEL_FINDER_OPEN_EVENT = "tomverse:model-finder-open";

export const openModelFinder = () => {
  window.dispatchEvent(new CustomEvent(MODEL_FINDER_OPEN_EVENT));
};
