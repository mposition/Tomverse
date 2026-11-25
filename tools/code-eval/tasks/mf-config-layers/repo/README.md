# Config

```js
const config = createConfig({ fileText });
config.get("server.port");      // 3000
config.get("missing", "dflt");  // "dflt"
config.value;                   // the merged object
```

Today: `DEFAULTS` (src/defaults.js) are merged with the parsed JSON file (src/file.js) by `deepMerge` (src/merge.js): objects merge key by key, arrays and scalars are replaced. A missing or blank `fileText` means no file; a file that is not valid JSON or not a JSON object throws `ConfigError`.

## To add

`createConfig({ fileText, env = {}, argv = [] })` with precedence defaults < file < env < command line.

Environment (`fromEnv(env, prefix = "APP_")` in src/env.js)
- Only variables whose name starts with the prefix count. The rest of the name is lower-cased and `__` separates nesting levels: `APP_SERVER__PORT=8080` gives `{ server: { port: 8080 } }`.
- Values are converted: `true` / `false` become booleans, text matching `^-?\d+(\.\d+)?$` becomes a number, text starting with `json:` is parsed as JSON after that prefix (invalid JSON throws `ConfigError` with the message `invalid JSON in <VARIABLE NAME>`); everything else stays a string.

Command line (`fromArgs(argv)` in src/cli.js)
- `--server.port=9090` sets a dotted path (same conversions as the environment, including `json:`; the value is everything after the first `=`); `--debug` sets `true`; `--no-debug` sets `false`. Arguments that do not start with `--` are ignored.

Merging and lookup
- Arrays and scalars from a higher layer replace the lower value; objects merge. A higher layer value of another type replaces it (an object replaced by a number, and so on).
- `config.get(path, fallback)` returns the value at the dotted path, or `fallback` when the path is not set (`undefined`). Values such as `false`, `0` and `""` are real values.
- `config.explain(path)` returns `{ value, source }` where `source` is the highest layer (`"cli"`, `"env"`, `"file"`, `"default"`) that has a value at exactly that path (for an object path, that has an object there); `{ value: undefined, source: null }` when no layer has it.
- The exported `DEFAULTS` and the layer objects are never modified by `createConfig`.
