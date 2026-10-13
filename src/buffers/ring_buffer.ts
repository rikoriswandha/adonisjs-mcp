/*
|--------------------------------------------------------------------------
| Bounded ring buffer
|--------------------------------------------------------------------------
|
| Fixed-capacity FIFO bounded by entry count and by the sum of entry sizes
| (serialized bytes, measured by the caller). Appending is O(1) amortized:
| each append evicts at most the entries it displaces. Slots are allocated
| as entries arrive (never more than `capacity`), and evicted slots are
| cleared so old entries can be garbage collected.
|
*/

export class RingBuffer<T> {
  readonly capacity: number
  readonly maxBytes: number
  readonly #items: Array<T | undefined> = []
  readonly #sizes: number[] = []
  #start = 0
  #length = 0
  #bytes = 0
  #evicted = 0

  constructor(capacity: number, maxBytes: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('RingBuffer capacity must be a positive integer')
    }
    this.capacity = capacity
    this.maxBytes = maxBytes
  }

  get length(): number {
    return this.#length
  }

  get bytes(): number {
    return this.#bytes
  }

  /**
   * Entries removed to make room since the buffer was created.
   */
  get evicted(): number {
    return this.#evicted
  }

  #evictOldest() {
    this.#bytes -= this.#sizes[this.#start]
    this.#items[this.#start] = undefined
    this.#sizes[this.#start] = 0
    this.#start = (this.#start + 1) % this.capacity
    this.#length--
    this.#evicted++
  }

  /**
   * Appends `item` of `size` bytes, evicting the oldest entries until both
   * bounds hold. Returns `false` (and stores nothing) when `size` alone
   * exceeds `maxBytes`; callers shorten entries before pushing.
   */
  push(item: T, size: number): boolean {
    if (size > this.maxBytes) {
      return false
    }
    while (
      this.#length > 0 &&
      (this.#length === this.capacity || this.#bytes + size > this.maxBytes)
    ) {
      this.#evictOldest()
    }
    const index = (this.#start + this.#length) % this.capacity
    this.#items[index] = item
    this.#sizes[index] = size
    this.#length++
    this.#bytes += size
    return true
  }

  /**
   * Entries from oldest to newest.
   */
  toArray(): T[] {
    const items: T[] = []
    for (let offset = 0; offset < this.#length; offset++) {
      items.push(this.#items[(this.#start + offset) % this.capacity] as T)
    }
    return items
  }

  clear() {
    while (this.#length > 0) {
      this.#evictOldest()
    }
    this.#evicted = 0
  }
}
