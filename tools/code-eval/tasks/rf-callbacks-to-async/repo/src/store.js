import { NotFoundError } from "./errors.js";

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class RecordStore {
    #records = new Map();

    read(id, callback) {
        setImmediate(() => {
            const record = this.#records.get(id);
            if (!record) return callback(new NotFoundError(id));
            callback(null, structuredClone(record));
        });
    }

    write(record, callback) {
        setImmediate(() => {
            if (!record || typeof record.id !== "string" || !record.id) return callback(new TypeError("record needs a string id"));
            this.#records.set(record.id, structuredClone(record));
            callback(null, record.id);
        });
    }

    list(callback) {
        setImmediate(() => callback(null, [...this.#records.values()].map((r) => structuredClone(r)).sort(byId)));
    }

    remove(id, callback) {
        setImmediate(() => {
            if (!this.#records.delete(id)) return callback(new NotFoundError(id));
            callback(null, true);
        });
    }
}
