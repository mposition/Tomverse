export const systemClock = { now: () => Date.now() };

export function manualClock(start = 0) {
    let current = start;
    return {
        now: () => current,
        advance(ms) {
            current += ms;
        },
        set(value) {
            current = value;
        },
    };
}
