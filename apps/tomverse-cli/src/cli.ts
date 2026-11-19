#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        process.stderr.write(`Unexpected error: ${(error as Error).message}\n`);
        process.exitCode = 1;
    }
);
