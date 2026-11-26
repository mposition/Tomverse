# User service

Three layers: `UserRepo` (storage), `UserService` (rules) and `createHandler(service)` (HTTP). A request is `{ method, path, body }`; a response is `{ status, body }`.

Routes: `GET /users/:id` (200 with the user), `POST /users` (201 with the new user).

## To add: typed errors

`src/errors.js` exports:
- `AppError extends Error`: `new AppError(message, { status, code })`, with `status` and `code` properties.
- `ValidationError(field, message)`: status 400, code `invalid_input`, property `field`.
- `NotFoundError(resource, id)`: status 404, code `not_found`, message `<resource> <id> not found`, properties `resource` and `id`.
- `ConflictError(message)`: status 409, code `conflict`.
All three extend `AppError`; their `name` is the class name.

Who throws what
- `UserService#getUser(id)`: `NotFoundError("user", id)` when there is no such user.
- `UserService#registerUser(input)`: `ValidationError("name", "name is required")` for a blank name and `ValidationError("email", "email is invalid")` for an invalid e-mail.
- `UserRepo#insert(user)`: `ConflictError("email already registered")` for an e-mail that is taken.

HTTP error responses have the body `{ error: { code, message } }` plus `field` when the error has one:
- an `AppError` is answered with its own `status`, `code` and `message`;
- an unknown route is `404` with code `not_found` and message `no such route`;
- any other error is `500` with code `internal` and the message `internal error`: the original message must never reach the client.
