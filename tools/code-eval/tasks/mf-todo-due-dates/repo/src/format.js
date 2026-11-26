export function formatTodo(todo) {
    return `[${todo.done ? "x" : " "}] ${todo.title}`;
}

export function formatList(todos) {
    return todos.map((todo) => formatTodo(todo)).join("\n");
}
