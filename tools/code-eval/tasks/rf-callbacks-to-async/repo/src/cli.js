// Runs one command against a store and reports the outcome as text.
export function runCommand(store, argv, callback) {
    const [command, ...args] = argv;
    switch (command) {
        case "get":
            return store.read(args[0], (error, record) => (error ? callback(error) : callback(null, JSON.stringify(record))));
        case "put": {
            let record;
            try {
                record = JSON.parse(args[1]);
            } catch {
                return callback(new SyntaxError("invalid json"));
            }
            record.id = args[0];
            return store.write(record, (error, id) => (error ? callback(error) : callback(null, `saved ${id}`)));
        }
        case "list":
            return store.list((error, records) => (error ? callback(error) : callback(null, records.map((r) => r.id).join("\n"))));
        case "rm":
            return store.remove(args[0], (error) => (error ? callback(error) : callback(null, `removed ${args[0]}`)));
        default:
            return callback(new Error(`unknown command: ${command}`));
    }
}
