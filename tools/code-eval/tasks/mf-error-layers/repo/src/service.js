export class UserService {
    constructor(repo) {
        this.repo = repo;
    }

    getUser(id) {
        const user = this.repo.findById(id);
        if (!user) throw new Error(`user ${id} not found`);
        return user;
    }

    registerUser(input) {
        const name = String(input?.name ?? "").trim();
        const email = String(input?.email ?? "").trim().toLowerCase();
        if (!name) throw new Error("name is required");
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("email is invalid");
        return this.repo.insert({ name, email });
    }
}
