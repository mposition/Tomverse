import { NotFoundError } from "./errors.js";

// Copies every record of `source` that `target` does not have yet.
export async function syncRecords(source, target) {
    const records = await source.list();
    const copied = [];
    const skipped = [];
    for (const record of records) {
        try {
            await target.read(record.id);
            skipped.push(record.id);
        } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
            await target.write(record);
            copied.push(record.id);
        }
    }
    return { copied, skipped };
}
