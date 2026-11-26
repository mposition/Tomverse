# Order totals

`computeTotal(items, { taxPercent, discountCents })` returns the order total in cents: the sum of `priceCents * qty`, minus the discount (never below zero), plus tax on the discounted amount (rounded to the nearest cent).

Where it is used
- `renderInvoice(items, options)` prints an invoice that ends with the `computeTotal` result.
- `dailyReport(orders)` adds up `computeTotal` for each order.
- `checkout(cart, payment)` charges the `computeTotal` of the cart.
- `calculators` is a registry of the available calculators: `calculators.computeTotal` and `calculators.default`.
