export class MemoryStorage {
    #notes = new Map();

    async get(id) {
        const note = this.#notes.get(id);
        return note ? structuredClone(note) : undefined;
    }

    async put(note) {
        this.#notes.set(note.id, structuredClone(note));
    }

    async delete(id) {
        return this.#notes.delete(id);
    }

    async list() {
        return [...this.#notes.values()].map((note) => structuredClone(note));
    }
}
