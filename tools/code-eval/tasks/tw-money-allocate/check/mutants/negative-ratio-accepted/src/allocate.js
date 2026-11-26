export function allocate(totalCents, ratios) {
    if (!Number.isInteger(totalCents)) throw new TypeError("totalCents must be an integer");
    if (!Array.isArray(ratios) || ratios.length === 0 || ratios.some((r) =>  !Number.isFinite(r))) {
        throw new RangeError("ratios must be non-negative numbers");
    }
    const weight = ratios.reduce((a, b) => a + b, 0);
    if (weight === 0) throw new RangeError("ratios must not all be zero");
    const sign = totalCents < 0 ? -1 : 1;
    const amount = Math.abs(totalCents);
    const shares = ratios.map((r) => Math.floor((amount * r) / weight));
    let left = amount - shares.reduce((a, b) => a + b, 0);
    for (let i = 0; left > 0; i = (i + 1) % shares.length) {
        if (ratios[i] > 0) {
            shares[i] += 1;
            left -= 1;
        }
    }
    return shares.map((s) => (s === 0 ? 0 : sign * s));
}
