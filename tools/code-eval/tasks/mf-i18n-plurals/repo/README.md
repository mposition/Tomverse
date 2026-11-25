# i18n

```js
const i18n = createI18n({ locale: "en", messages: { en: { greeting: "Hello, {name}!" } } });
i18n.t("greeting", { name: "Ann" }); // "Hello, Ann!"
```

Today: `t(key, params)` returns the message of the current locale with `{name}` placeholders replaced by `params.name` (a placeholder without a param is left as it is) or the key itself when the current locale has no such message. `has(key)`, `locale` and `setLocale(locale)` exist. `locales/en.js` and `locales/de.js` are ready-made message sets.

## To add

- Plural messages: a message may be an object with any of the keys `zero`, `one`, `two`, `few`, `many`, `other` instead of a string. `t(key, { count })` picks the form: `zero` when `count === 0` and the message has a `zero` form; otherwise the category that `new Intl.PluralRules(locale).select(count)` returns for the current locale (for example `en`: `one` or `other`; `ru`: `one`, `few`, `many` or `other`). If the message has no form for that category, `other` is used. If `count` is missing or not a finite number, `other` is used. If there is no usable form at all, the key is returned.
- Number formatting: a number parameter is formatted with `new Intl.NumberFormat(locale).format(value)` for the current locale (`1234` becomes `1,234` in `en` and `1.234` in `de`). Other values use `String(value)`. This applies to every message, plural or not.
- Fallback chain: a key is looked up in the current locale (for example `en-GB`), then in its language (`en`), then in the `fallbackLocale` option (default `"en"`), then in the fallback's language. The first locale that has the key wins (even when it is a plural message and the current locale is different: plural categories and number formatting still use the current locale). `has(key)` follows the same chain. When no locale has the key, `t` returns the key.
- Own properties only: keys such as `constructor` or `toString` are not messages.
