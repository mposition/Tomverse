// Minimal synchronous event emitter.
export class Emitter {
    #handlers = new Map();

    on(event, fn) {
        return this.#add(event, fn, false);
    }

    once(event, fn) {
        return this.#add(event, fn, true);
    }

    off(event, fn) {
        const list = this.#handlers.get(event);
        if (!list) return false;
        const index = list.findIndex((h) => h.fn === fn);
        if (index < 0) return false;
        list.splice(index, 1);
        return true;
    }

    emit(event, ...args) {
        const snapshot = [...(this.#handlers.get(event) ?? [])];
        let failed = false;
        let firstError;
        for (const handler of snapshot) {
            if (handler.once) this.off(event, handler.fn);
            try {
                handler.fn(...args);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
        if (failed) throw firstError;
        return snapshot.length > 0;
    }

    listenerCount(event) {
        return this.#handlers.get(event)?.length ?? 0;
    }

    #add(event, fn, once) {
        if (typeof fn !== "function") throw new TypeError("handler must be a function");
        const list = this.#handlers.get(event) ?? [];
        list.push({ fn, once });
        this.#handlers.set(event, list);
        return () => this.off(event, fn);
    }
}
