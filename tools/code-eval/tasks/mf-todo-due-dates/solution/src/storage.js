import { normalizeDueDate } from "./validate.js";

export function serialize(todos) {
    return JSON.stringify(todos.map(({ id, title, done, dueDate, createdAt }) => ({ id, title, done, dueDate: dueDate ?? null, createdAt })));
}

export function deserialize(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new TypeError("expected a list of todos");
    return data.map((item) => ({
        id: item.id,
        title: String(item.title),
        done: Boolean(item.done),
        dueDate: normalizeDueDate(item.dueDate),
        createdAt: item.createdAt,
    }));
}
