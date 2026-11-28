import { NotFoundError } from "./errors.js";

// Copies every record of `source` that `target` does not have yet.
export function syncRecords(source, target, callback) {
    source.list((listError, records) => {
        if (listError) return callback(listError);
        const copied = [];
        const skipped = [];
        let index = 0;
        const next = () => {
            if (index >= records.length) return callback(null, { copied, skipped });
            const record = records[index++];
            target.read(record.id, (readError) => {
                if (!readError) {
                    skipped.push(record.id);
                    return next();
                }
                if (!(readError instanceof NotFoundError)) return callback(readError);
                target.write(record, (writeError) => {
                    if (writeError) return callback(writeError);
                    copied.push(record.id);
                    next();
                });
            });
        };
        next();
    });
}
