/**
 * The advisory lock every write of an optimizer cycle's state takes after the
 * audit chain lock: reserving, finishing, promoting, a recommendation's status
 * and the optimizer's own setting changes. Its own module so the settings
 * code can take it without importing the optimizer.
 */
export const OPTIMIZER_LOCK = "auto-router-optimizer";
