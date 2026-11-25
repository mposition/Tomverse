# Inventory

`new Inventory({ clock })` (the clock defaults to the system clock; any object with `now()` in milliseconds works, `manualClock()` is for tests).

Already supported: `add(sku, qty)`, `remove(sku, qty)` (throws `InsufficientStockError` when the stock is too low), `onHand(sku)`.

To add
- `reserve(sku, qty, { ttlMs = 900000 } = {})` holds `qty` units for `ttlMs` and returns a reservation id (a unique string). It throws `InsufficientStockError` when `qty` is more than `available(sku)`.
- A reservation is expired when `clock.now() >= createdAt + ttlMs`. Expired reservations hold nothing.
- `available(sku)` is `onHand(sku)` minus the units held by live reservations. `reservedQty(sku)` is the units held by live reservations.
- `release(id)` frees a live reservation and returns `true`; it returns `false` for an unknown, expired or already used id.
- `commit(id)` takes the reserved units out of stock (`onHand` goes down by that quantity) and ends the reservation. It throws `ReservationError` (src/errors.js) whose `code` is `"unknown"` for an unknown or already used id and `"expired"` for an expired one.
- `remove(sku, qty)` may only take units that are `available`; otherwise it throws `InsufficientStockError`.
- Quantities must be positive integers: `add`, `remove` and `reserve` throw a `RangeError` otherwise.
