# Argument parser

`parseArgs(argv, schema)` returns `{ values, positionals }`.

```js
const schema = {
    options: {
        verbose: { type: "boolean", short: "v" },
        out: { type: "string", short: "o" },
        count: { type: "number", short: "n" },
        tag: { type: "string", multiple: true },
    },
};
```

Already supported: `--out file`, `--verbose`, positional arguments, and defaults (`default` in the option schema).

To add
- `--out=file` (the value may be empty and may contain `=`).
- `--no-verbose` sets a boolean option to `false`. `--no-x` for a non-boolean or unknown option is an error.
- Short options: `-v`, `-o file`, `-ofile` (value attached), and combined boolean shorts `-vq`; a value short option may end a combination (`-vo file`). A boolean given a value (`--verbose=yes`) is an error.
- `--` ends option parsing: everything after it is a positional, even if it starts with `-`. A lone `-` is a positional.
- `multiple: true` collects every occurrence into an array in order (default `[]`). Without `multiple`, a repeated option keeps the last value.
- `type: "number"`: the value must satisfy `Number.isFinite(Number(text))` and not be empty; the value becomes a number. A negative number can be given as `--count=-1` or `-n -1`.
- Errors are `UsageError` (src/errors.js) with these messages: `unknown option --x` / `unknown option -x`, `option --out needs a value` (also when the next argument is missing or starts with `-` and is not a number for a value option; use `--out=-x` to pass such a value), `option --count must be a number: abc`, `option --verbose does not take a value`, `option --no-x is not a boolean`.
