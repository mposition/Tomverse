import { NotFoundError } from "./errors.js";

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const tick = () => new Promise((resolve) => setImmediate(resolve));

export class RecordStore {
    #records = new Map();

    async read(id) {
        await tick();
        const record = this.#records.get(id);
        if (!record) throw new NotFoundError(id);
        return structuredClone(record);
    }

    async write(record) {
        await tick();
        if (!record || typeof record.id !== "string" || !record.id) throw new TypeError("record needs a string id");
        this.#records.set(record.id, structuredClone(record));
        return record.id;
    }

    async list() {
        await tick();
        return [...this.#records.values()].map((r) => structuredClone(r)).sort(byId);
    }

    async remove(id) {
        await tick();
        if (!this.#records.delete(id)) throw new NotFoundError(id);
        return true;
    }
}
