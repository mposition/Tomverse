# Router

```js
const router = new Router();
router.add("GET", "/users/:id", handler);
router.match("GET", "/users/42?tab=posts");
// -> { handler, params: { id: "42" }, query: { tab: "posts" } }   or null
```

Rules
- Paths are case-sensitive. Leading, trailing and repeated slashes are ignored. The query string and `#hash` are not part of the path.
- `:name` matches exactly one segment and stores it in `params.name`, decoded with `decodeURIComponent`. If a segment has a malformed percent escape (such as `%E0%A4%A`), the route does not match.
- `*` as the last segment matches the rest of the path (one or more segments) and stores them joined with `/` in `params["*"]`, still encoded as sent.
- When several routes match, the more specific one wins, comparing segment by segment from the left: a static segment beats `:param`, which beats `*`. Registration order only breaks exact ties (first registered wins).
- Methods are case-insensitive. `ANY` matches every method, but a route registered for the exact method wins over an `ANY` route of the same path shape.
- `query`: parsed from the query string with `decodeURIComponent`, `+` meaning a space; a key that appears more than once becomes an array in order; a key without `=` has the value `""`. No query string gives `{}`.
- `allowedMethods(url)` returns the sorted, upper-case list of methods of routes whose path matches the url (an `ANY` route contributes `"ANY"`).
