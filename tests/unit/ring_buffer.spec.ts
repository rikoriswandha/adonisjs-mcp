import { test } from '@japa/runner'
import { RingBuffer } from '../../src/buffers/ring_buffer.js'

test.group('RingBuffer', () => {
  test('keeps the newest entries in order when the count wraps around', ({ assert }) => {
    const buffer = new RingBuffer<number>(3, 1000)
    for (let value = 1; value <= 7; value++) {
      buffer.push(value, 1)
    }
    assert.deepEqual(buffer.toArray(), [5, 6, 7])
    assert.equal(buffer.evicted, 4)
    assert.equal(buffer.bytes, 3)
  })

  test('evicts the oldest entries until the byte budget holds', ({ assert }) => {
    const buffer = new RingBuffer<string>(10, 100)
    buffer.push('a', 40)
    buffer.push('b', 40)
    buffer.push('c', 50)
    assert.deepEqual(buffer.toArray(), ['b', 'c'])
    assert.equal(buffer.bytes, 90)

    buffer.push('d', 100)
    assert.deepEqual(buffer.toArray(), ['d'])
    assert.equal(buffer.evicted, 3)
  })

  test('rejects an entry larger than the whole budget without evicting', ({ assert }) => {
    const buffer = new RingBuffer<string>(10, 100)
    buffer.push('kept', 60)
    assert.isFalse(buffer.push('huge', 101))
    assert.deepEqual(buffer.toArray(), ['kept'])
    assert.equal(buffer.bytes, 60)
  })

  test('clear() empties the buffer and resets accounting', ({ assert }) => {
    const buffer = new RingBuffer<number>(2, 10)
    buffer.push(1, 5)
    buffer.push(2, 5)
    buffer.push(3, 5)
    buffer.clear()
    assert.deepEqual(buffer.toArray(), [])
    assert.equal(buffer.bytes, 0)
    assert.equal(buffer.evicted, 0)
    buffer.push(4, 5)
    assert.deepEqual(buffer.toArray(), [4])
  })
})
