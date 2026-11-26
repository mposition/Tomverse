export class AbortError extends Error {
    constructor(message = "retry aborted", options) {
        super(message, options);
        this.name = "AbortError";
    }
}
