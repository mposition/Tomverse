// Runs one command against a store and reports the outcome as text.
export async function runCommand(store, argv) {
    const [command, ...args] = argv;
    switch (command) {
        case "get":
            return JSON.stringify(await store.read(args[0]));
        case "put": {
            let record;
            try {
                record = JSON.parse(args[1]);
            } catch {
                throw new SyntaxError("invalid json");
            }
            record.id = args[0];
            return `saved ${await store.write(record)}`;
        }
        case "list":
            return (await store.list()).map((r) => r.id).join("\n");
        case "rm":
            await store.remove(args[0]);
            return `removed ${args[0]}`;
        default:
            throw new Error(`unknown command: ${command}`);
    }
}
