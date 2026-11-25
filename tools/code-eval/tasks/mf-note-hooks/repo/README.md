# Notes

`NotesService({ storage, clock })` with async `create`, `update`, `remove`, `get` and `list`. `MemoryStorage` is the storage used in tests; `fixedClock(iso)` is a clock.

- `create({ title, body = "" })` validates (`title` must be a non-blank string, at most 100 characters, else `ValidationError`), saves `{ id, title, body, createdAt, updatedAt }` (ids are `n1`, `n2`, ...) and returns the saved note.
- `update(id, changes)` applies `title` and/or `body` (validated the same way), sets `updatedAt`, saves and returns the note. Unknown ids throw `NotFoundError`. Other keys in `changes` are ignored.
- `remove(id)` deletes the note; unknown ids throw `NotFoundError`.

## To add: hooks

`HookRegistry` (src/hooks.js)
- `register(name, fn, { priority = 0 } = {})` returns a function that unregisters the hook. Valid names: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeRemove`, `afterRemove`; any other name throws `Error("unknown hook: <name>")`. `fn` must be a function (else `TypeError`).
- `run(name, payload)` is async. It runs the hooks of that name one after another (each is awaited), highest `priority` first, equal priorities in registration order. Every hook receives the current payload. When a hook returns a plain object (not an array, not null) that object becomes the payload for the next hook; any other return value leaves the payload as it is. `run` resolves with the final payload. If a hook throws or rejects, `run` rejects with that same error at once and later hooks do not run. A hook that is unregistered is not run by later `run` calls.

`NotesService({ storage, clock, hooks = new HookRegistry(), onHookError })`
- `create(input)`: the validated draft `{ title, body }` is the payload of `beforeCreate`. The (possibly replaced) payload is what gets saved: its `title` and `body` are validated again, then `id` and timestamps are added. If a `beforeCreate` hook throws, nothing is saved and the error is thrown unchanged. After saving, `afterCreate` runs with the saved note.
- `update(id, changes)`: `beforeUpdate` receives `{ changes }` (only `title` and `body`) after the note was found; the possibly replaced `changes` are validated and saved. `afterUpdate` receives the saved note.
- `remove(id)`: `beforeRemove` receives the note about to be removed (a replaced payload has no effect); if it throws the note is kept. `afterRemove` receives the removed note.
- `after*` hooks cannot fail the operation: an error from an `after*` run is passed to `onHookError(error, hookName)` (when given) and otherwise ignored; the operation still returns its normal result. The remaining hooks of that `after*` name do not run after the first error.
