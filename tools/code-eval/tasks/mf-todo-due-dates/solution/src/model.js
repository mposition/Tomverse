export function createTodo(id, fields, now) {
    return { id, title: fields.title, done: false, dueDate: fields.dueDate ?? null, createdAt: now };
}
