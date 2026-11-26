export class PriorityQueue {
    #heap = [];
    #seq = 0;

    get size() {
        return this.#heap.length;
    }

    isEmpty() {
        return this.#heap.length === 0;
    }

    push(item, priority = 0) {
        if (typeof priority !== "number" || Number.isNaN(priority)) throw new TypeError("priority must be a number");
        this.#heap.push({ item, priority, seq: this.#seq++ });
        this.#siftUp(this.#heap.length - 1);
        return this;
    }

    peek() {
        return this.#heap.length === 0 ? undefined : this.#heap[0].item;
    }

    pop() {
        if (this.#heap.length === 0) return undefined;
        const top = this.#heap[0];
        const last = this.#heap.pop();
        if (this.#heap.length > 0) {
            this.#heap[0] = last;
            this.#siftDown(0);
        }
        return top.item;
    }

    drain() {
        const out = [];
        while (!this.isEmpty()) out.push(this.pop());
        return out;
    }

    #less(a, b) {
        return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);
    }

    #siftUp(index) {
        let i = index;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this.#less(this.#heap[i], this.#heap[parent])) break;
            [this.#heap[i], this.#heap[parent]] = [this.#heap[parent], this.#heap[i]];
            i = parent;
        }
    }

    #siftDown(index) {
        const n = this.#heap.length;
        let i = index;
        for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let smallest = i;
            if (left < n && this.#less(this.#heap[left], this.#heap[smallest])) smallest = left;
            if (right < n && this.#less(this.#heap[right], this.#heap[smallest])) smallest = right;
            if (smallest === i) return;
            [this.#heap[i], this.#heap[smallest]] = [this.#heap[smallest], this.#heap[i]];
            i = smallest;
        }
    }
}
