# allocate(totalCents, ratios)

Splits an amount of money, in integer cents, between shares in proportion to `ratios`.

- `totalCents` must be an integer (negative is allowed), otherwise a TypeError is thrown.
- `ratios` must be a non-empty array of finite numbers that are zero or more, and at least one must be greater than zero; otherwise a RangeError is thrown.
- Each share starts as `floor(abs(total) * ratio / sum(ratios))`. The cents that are left over are handed out one at a time, going through the shares from the first to the last (and starting again at the first if needed), skipping shares whose ratio is zero.
- A negative total is split as its absolute value and the shares are negated; no share is ever `-0`.
- The shares always add up to exactly `totalCents`, and a share with ratio 0 is always 0.
