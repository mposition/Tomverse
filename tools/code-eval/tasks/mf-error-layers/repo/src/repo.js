export class UserRepo {
    #users = new Map();
    #nextId = 1;

    findById(id) {
        const user = this.#users.get(id);
        return user ? { ...user } : null;
    }

    findByEmail(email) {
        for (const user of this.#users.values()) if (user.email === email) return { ...user };
        return null;
    }

    insert(user) {
        if (this.findByEmail(user.email)) throw new Error("email already registered");
        const record = { id: this.#nextId++, ...user };
        this.#users.set(record.id, record);
        return { ...record };
    }
}
