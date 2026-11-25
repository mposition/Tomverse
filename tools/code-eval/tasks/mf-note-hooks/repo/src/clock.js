export const systemClock = { now: () => new Date().toISOString() };
export const fixedClock = (iso) => ({ now: () => iso });
