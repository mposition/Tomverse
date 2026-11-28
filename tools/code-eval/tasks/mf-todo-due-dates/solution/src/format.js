export function formatTodo(todo, today) {
    let line = `[${todo.done ? "x" : " "}] ${todo.title}`;
    if (todo.dueDate) {
        line += ` (due ${todo.dueDate})`;
        if (today && !todo.done && todo.dueDate < today) line += " OVERDUE";
    }
    return line;
}

export function formatList(todos, today) {
    return todos.map((todo) => formatTodo(todo, today)).join("\n");
}
