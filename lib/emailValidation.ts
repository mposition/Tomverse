// Shared between the sign-in form (client) and the email-login request route
// (server) so the two never disagree about what counts as a valid address.
// No framework/runtime imports -- safe to bundle on the client.
//
// Deliberately permissive: legitimate addresses use `+`, `.`, `'`, `-`, and
// other punctuation in the local part (e.g. "name+test@example.com"), so
// this mirrors the WHATWG HTML `type="email"` pattern rather than a
// hand-rolled strict regex that would reject them.
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export const MAX_LOGIN_EMAIL_LENGTH = 254;

export function normalizeLoginEmailInput(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidLoginEmail(raw: string): boolean {
  const value = normalizeLoginEmailInput(raw);
  return (
    value.length > 0 &&
    value.length <= MAX_LOGIN_EMAIL_LENGTH &&
    EMAIL_PATTERN.test(value)
  );
}
