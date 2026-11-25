import { NotFoundError, ValidationError } from "./errors.js";

export class UserService {
    constructor(repo) {
        this.repo = repo;
    }

    getUser(id) {
        const user = this.repo.findById(id);
        if (!user) throw new NotFoundError("user", id);
        return user;
    }

    registerUser(input) {
        const name = String(input?.name ?? "").trim();
        const email = String(input?.email ?? "").trim().toLowerCase();
        if (!name) throw new ValidationError("name", "name is required");
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ValidationError("email", "email is invalid");
        return this.repo.insert({ name, email });
    }
}
