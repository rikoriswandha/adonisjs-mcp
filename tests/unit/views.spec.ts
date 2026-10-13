import { test } from '@japa/runner'
import { viewSlots } from '../../src/introspection/views.js'

test.group('Edge slot source references', () => {
  test('deduplicates literal references and distinguishes dynamic completeness', ({ assert }) => {
    assert.deepEqual(viewSlots('{{ await $slots.main() }} {{ $slots.footer }} {{ $slots.main }}'), {
      names: ['footer', 'main'],
      completeness: 'complete',
    })
    assert.deepEqual(viewSlots('{{ $slots.main }} {{ await $slots[name]() }}'), {
      names: ['main'],
      completeness: 'partial',
    })
    assert.deepEqual(viewSlots('{{ $slots[expression] }}'), { names: [], completeness: 'unknown' })
    assert.deepEqual(viewSlots('<p>No slot references</p>'), {
      names: [],
      completeness: 'complete',
    })
  })
})
