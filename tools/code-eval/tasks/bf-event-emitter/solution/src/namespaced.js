import { Emitter } from "./emitter.js";

// A view of one Emitter where every event name is prefixed with `${name}:`.
export function scope(emitter, name) {
    const full = (event) => `${name}:${event}`;
    const registered = [];
    return {
        on(event, fn) {
            const off = emitter.on(full(event), fn);
            registered.push(off);
            return off;
        },
        once(event, fn) {
            const off = emitter.once(full(event), fn);
            registered.push(off);
            return off;
        },
        off: (event, fn) => emitter.off(full(event), fn),
        emit: (event, ...args) => emitter.emit(full(event), ...args),
        clear() {
            for (const off of registered.splice(0)) off();
        },
    };
}

export { Emitter };
