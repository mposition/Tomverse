import { ValidationError } from "./errors.js";

export function validateTodoInput(input) {
    const title = String(input?.title ?? "").trim();
    if (!title) throw new ValidationError("title", "title is required");
    if (title.length > 100) throw new ValidationError("title", "title must be at most 100 characters");
    return { title };
}
