# PriorityQueue

A binary min-heap that is stable for equal priorities.

- `push(item, priority = 0)` adds an item and returns the queue (so calls can be chained). `priority` must be a number that is not NaN, otherwise a TypeError is thrown.
- The item with the smallest priority number leaves first. Items with equal priority leave in the order they were pushed (first in, first out).
- `pop()` removes and returns the next item; on an empty queue it returns `undefined`.
- `peek()` returns the next item without removing it; `undefined` when empty.
- `size` (a getter) is the number of items; `isEmpty()` tells whether it is zero.
- `drain()` pops everything and returns the items as an array in leaving order.
