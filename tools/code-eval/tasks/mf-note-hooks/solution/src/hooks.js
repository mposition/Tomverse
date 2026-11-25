const NAMES = ["beforeCreate", "afterCreate", "beforeUpdate", "afterUpdate", "beforeRemove", "afterRemove"];
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export class HookRegistry {
    #hooks = new Map(NAMES.map((name) => [name, []]));
    #order = 0;

    register(name, fn, { priority = 0 } = {}) {
        const list = this.#hooks.get(name);
        if (!list) throw new Error(`unknown hook: ${name}`);
        if (typeof fn !== "function") throw new TypeError("hook must be a function");
        const entry = { fn, priority, order: this.#order++ };
        list.push(entry);
        return () => {
            const index = list.indexOf(entry);
            if (index >= 0) list.splice(index, 1);
        };
    }

    async run(name, payload) {
        const list = this.#hooks.get(name);
        if (!list) throw new Error(`unknown hook: ${name}`);
        const queue = [...list].sort((a, b) => b.priority - a.priority || a.order - b.order);
        let current = payload;
        for (const entry of queue) {
            if (!list.includes(entry)) continue;
            const result = await entry.fn(current);
            if (isPlainObject(result)) current = result;
        }
        return current;
    }
}
