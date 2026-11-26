import { ValidationError } from "./errors.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(text) {
    const match = DATE.exec(text);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// null for "no due date"; throws ValidationError for anything that is not a valid date.
export function normalizeDueDate(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    if (typeof value !== "string" || !isValidDate(value)) {
        throw new ValidationError("dueDate", "dueDate must be a valid date (YYYY-MM-DD)");
    }
    return value;
}

export function validateTodoInput(input) {
    const title = String(input?.title ?? "").trim();
    if (!title) throw new ValidationError("title", "title is required");
    if (title.length > 100) throw new ValidationError("title", "title must be at most 100 characters");
    return { title, dueDate: normalizeDueDate(input?.dueDate) };
}
