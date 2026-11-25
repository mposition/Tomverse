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
        const list = this.#handlers.get(event) ?? [];
        for (const handler of list) {
            if (handler.once) this.off(event, handler.fn);
            handler.fn(...args);
        }
        return list.length > 0;
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
