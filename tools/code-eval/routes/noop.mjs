// Tool self-check: changes nothing. Every task must fail with it, which proves
// that no task is already in a passing state.
export const route = {
    name: "noop",
    paid: false,
    description: "does nothing (proves every task starts failing)",
    async run() {
        return { status: "ok" };
    },
};
