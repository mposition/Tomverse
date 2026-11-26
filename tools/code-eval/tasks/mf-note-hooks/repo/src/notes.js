import { systemClock } from "./clock.js";
import { NotFoundError, ValidationError } from "./errors.js";

function cleanTitle(title) {
    const text = typeof title === "string" ? title.trim() : "";
    if (!text) throw new ValidationError("title", "title is required");
    if (text.length > 100) throw new ValidationError("title", "title must be at most 100 characters");
    return text;
}

const cleanBody = (body) => (typeof body === "string" ? body : "");

export class NotesService {
    #seq = 0;

    constructor({ storage, clock = systemClock }) {
        this.storage = storage;
        this.clock = clock;
    }

    async create(input) {
        const draft = { title: cleanTitle(input?.title), body: cleanBody(input?.body) };
        const now = this.clock.now();
        const note = { id: `n${++this.#seq}`, ...draft, createdAt: now, updatedAt: now };
        await this.storage.put(note);
        return note;
    }

    async update(id, changes = {}) {
        const existing = await this.storage.get(id);
        if (!existing) throw new NotFoundError(id);
        const note = { ...existing, updatedAt: this.clock.now() };
        if ("title" in changes) note.title = cleanTitle(changes.title);
        if ("body" in changes) note.body = cleanBody(changes.body);
        await this.storage.put(note);
        return note;
    }

    async remove(id) {
        if (!(await this.storage.get(id))) throw new NotFoundError(id);
        await this.storage.delete(id);
    }

    get(id) {
        return this.storage.get(id);
    }

    list() {
        return this.storage.list();
    }
}
