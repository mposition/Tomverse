import { NotFoundError } from "./errors.js";
import { formatList } from "./format.js";
import { createTodo } from "./model.js";
import { deserialize, serialize } from "./storage.js";
import { validateTodoInput } from "./validate.js";

export const systemClock = {
    now: () => new Date().toISOString(),
    today: () => new Date().toISOString().slice(0, 10),
};

export const fixedClock = (iso) => ({
    now: () => iso,
    today: () => iso.slice(0, 10),
});

export class TodoApi {
    #todos = [];
    #nextId = 1;

    constructor({ clock = systemClock } = {}) {
        this.clock = clock;
    }

    add(input) {
        const fields = validateTodoInput(input);
        const todo = createTodo(this.#nextId++, fields, this.clock.now());
        this.#todos.push(todo);
        return { ...todo };
    }

    complete(id) {
        const todo = this.#todos.find((t) => t.id === id);
        if (!todo) throw new NotFoundError(id);
        todo.done = true;
        return { ...todo };
    }

    list({ filter = "all" } = {}) {
        let items;
        if (filter === "all") items = this.#todos;
        else if (filter === "open") items = this.#todos.filter((t) => !t.done);
        else if (filter === "done") items = this.#todos.filter((t) => t.done);
        else throw new RangeError(`unknown filter: ${filter}`);
        return items.map((t) => ({ ...t }));
    }

    save() {
        return serialize(this.#todos);
    }

    load(text) {
        this.#todos = deserialize(text);
        this.#nextId = this.#todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    }

    render() {
        return formatList(this.list());
    }
}
