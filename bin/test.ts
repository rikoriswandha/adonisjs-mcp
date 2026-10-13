import { assert } from '@japa/assert'
import { expectTypeOf } from '@japa/expect-type'
import { configure, processCLIArgs, run } from '@japa/runner'

processCLIArgs(process.argv.splice(2))

configure({
  suites: [
    {
      name: 'unit',
      files: ['tests/unit/**/*.spec.ts'],
      timeout: 5_000,
    },
    {
      name: 'integration',
      files: ['tests/integration/**/*.spec.ts'],
      timeout: 600_000,
    },
    {
      name: 'security',
      files: ['tests/security/**/*.spec.ts'],
      timeout: 600_000,
    },
  ],
  plugins: [assert(), expectTypeOf()],
})

run()
