import { systemClock } from "./clock.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { HookRegistry } from "./hooks.js";

function cleanTitle(title) {
    const text = typeof title === "string" ? title.trim() : "";
    if (!text) throw new ValidationError("title", "title is required");
    if (text.length > 100) throw new ValidationError("title", "title must be at most 100 characters");
    return text;
}

const cleanBody = (body) => (typeof body === "string" ? body : "");

export class NotesService {
    #seq = 0;

    constructor({ storage, clock = systemClock, hooks = new HookRegistry(), onHookError }) {
        this.storage = storage;
        this.clock = clock;
        this.hooks = hooks;
        this.onHookError = onHookError;
    }

    async #after(name, payload) {
        try {
            await this.hooks.run(name, payload);
        } catch (error) {
            if (this.onHookError) this.onHookError(error, name);
        }
    }

    async create(input) {
        const initial = { title: cleanTitle(input?.title), body: cleanBody(input?.body) };
        const draft = await this.hooks.run("beforeCreate", initial);
        const now = this.clock.now();
        const title = cleanTitle(draft?.title);
        const body = cleanBody(draft?.body);
        const note = { id: `n${++this.#seq}`, title, body, createdAt: now, updatedAt: now };
        await this.storage.put(note);
        await this.#after("afterCreate", note);
        return note;
    }

    async update(id, changes = {}) {
        const existing = await this.storage.get(id);
        if (!existing) throw new NotFoundError(id);
        const initial = {};
        if ("title" in changes) initial.title = changes.title;
        if ("body" in changes) initial.body = changes.body;
        const payload = await this.hooks.run("beforeUpdate", { changes: initial });
        const applied = payload?.changes ?? {};
        const note = { ...existing, updatedAt: this.clock.now() };
        if ("title" in applied) note.title = cleanTitle(applied.title);
        if ("body" in applied) note.body = cleanBody(applied.body);
        await this.storage.put(note);
        await this.#after("afterUpdate", note);
        return note;
    }

    async remove(id) {
        const existing = await this.storage.get(id);
        if (!existing) throw new NotFoundError(id);
        await this.hooks.run("beforeRemove", existing);
        await this.storage.delete(id);
        await this.#after("afterRemove", existing);
    }

    get(id) {
        return this.storage.get(id);
    }

    list() {
        return this.storage.list();
    }
}
