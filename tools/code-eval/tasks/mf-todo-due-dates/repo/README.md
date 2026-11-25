# Todo API

`TodoApi` keeps todos in memory: `add`, `complete`, `list`, `save`, `load`, `render`. Saving writes JSON text (`serialize`) and loading reads it back (`deserialize`). Dates and times come from an injectable clock defined next to `TodoApi` in src/api.js (`fixedClock("2024-05-01T12:00:00.000Z")` in tests; its `today()` is `"2024-05-01"`).

## To add: due dates

- `add({ title, dueDate })`: `dueDate` is optional. It is a calendar date `YYYY-MM-DD` (four-digit year, two-digit month and day, a date that exists; leap years count). Missing, `undefined`, `null` and a blank string mean "no due date" and are stored as `null`. Anything else throws `ValidationError` with `field === "dueDate"` and the message `dueDate must be a valid date (YYYY-MM-DD)`.
- Every todo has a `dueDate` property: a string or `null`. `validateTodoInput` returns `{ title, dueDate }`.
- `serialize` / `deserialize` keep `dueDate`. Text saved before this feature has no `dueDate` and loads as `null`. Saved text with a `dueDate` that is neither `null` nor a valid date string is rejected with the same `ValidationError`.
- `formatTodo(todo, today)` is unchanged when `dueDate` is `null`; otherwise it appends ` (due YYYY-MM-DD)`. When `today` (a `YYYY-MM-DD` string) is given, the todo is not done and its `dueDate` is earlier than `today`, it also appends ` OVERDUE` after that. `formatList(todos, today)` passes `today` on.
- `TodoApi#list({ filter, sort })`: `filter` is `"all"` (default), `"open"`, `"done"` or the new `"overdue"` (open todos whose `dueDate` is earlier than `clock.today()`); `sort` is `"id"` (default) or `"due"` (earliest due date first, todos without a due date last, ties by id).
- `TodoApi#render()` renders the whole list with today's date from the clock.
