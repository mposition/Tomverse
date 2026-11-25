// Integer-cent helpers.

export function percentOf(amountCents, percent) {
    return Math.floor((amountCents * percent) / 100);
}

export function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

export function formatCents(cents) {
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
