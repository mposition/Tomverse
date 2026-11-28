# Cart totals

All amounts are integer cents.

- A line subtotal is `priceCents * qty`.
- A `percent` discount takes that percentage of the line subtotal, rounded half up to the cent.
- A `fixed` discount takes a fixed number of cents off the line, but never more than the line subtotal.
- `taxable` is the sum of line subtotals minus the sum of line discounts.
- Tax is `taxRatePercent` of `taxable`, rounded half up (once per cart, not per line).
- Shipping is free when `taxable >= freeShippingFromCents` (default 5000), otherwise `shippingCents` (default 599). An empty cart has no shipping.
- `total = taxable + tax + shipping`.
