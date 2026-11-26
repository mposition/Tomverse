export function createTodo(id, fields, now) {
    return { id, title: fields.title, done: false, createdAt: now };
}
