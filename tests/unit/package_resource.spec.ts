import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApplicationService } from '@adonisjs/core/types'
import { test } from '@japa/runner'
import { Redactor } from '../../src/redaction.js'
import { maskManifestString, PackageResource } from '../../src/resources/package.js'

test.group('Package resource', () => {
  test('masks URL credentials, sensitive queries, assignments and flags', ({ assert }) => {
    for (const value of [
      'git+https://ghp_secret@github.com/o/r.git',
      'https://token:x-oauth-basic@github.com/o/r.git',
    ])
      assert.include(maskManifestString(value), '://[REDACTED]@')
    assert.equal(
      maskManifestString('https://reg/p?token=x&auth=y&version=2'),
      'https://reg/p?token=[REDACTED]&auth=[REDACTED]&version=2'
    )
    for (const value of [
      'authToken=x',
      'dbPassword=x',
      '//registry/:_authToken=x',
      '--authToken=x',
      '--password x',
      '--password "two words"',
    ]) {
      assert.notInclude(maskManifestString(`npm ${value}`, true), 'x')
      assert.include(maskManifestString(`npm ${value}`, true), '[REDACTED]')
    }
    assert.equal(maskManifestString('npm --version 2', true), 'npm --version 2')
  })
  for (const scenario of ['spread', 'presets', 'nonliteral'] as const) {
    test(`${scenario} reports one limitation per rc field`, async ({ assert, cleanup }) => {
      const root = await mkdtemp(join(tmpdir(), 'mcp-package-'))
      cleanup(() => rm(root, { recursive: true, force: true }))
      await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: { 'csrf-tokens': '^1.2.3', '@aws-sdk/credential-providers': '^3.0.0' },
          devDependencies: { probe: 'git+https://username-secret@github.com/o/r.git' },
          peerDependencies: { probe: 'https://reg/p?token=query-secret' },
          optionalDependencies: { probe: 'https://user:password-secret@reg/p' },
          scripts: { authToken: 'npm run test' },
        })
      )
      const entries =
        scenario === 'spread'
          ? "[...extra, () => import('last')]"
          : scenario === 'nonliteral'
            ? '[first, second]'
            : "[() => import('first'), () => import('last')]"
      await writeFile(
        join(root, 'adonisrc.ts'),
        `export default defineConfig({providers: ${entries}, preloads: ${entries}, commands: ${entries}})`
      )
      const app = {
        rcFile: {
          raw: { presets: scenario === 'presets' ? [{}] : [] },
          providers: [{}, {}],
          preloads: [{}, {}],
          commands: [{}, {}],
          hooks: {},
        },
      } as unknown as ApplicationService
      const result = await new PackageResource(app, root, new Redactor([])).read()
      const rc = result.data.rc as Record<
        'providers' | 'preloads' | 'commands',
        { specifier: string | null }[]
      >
      for (const field of ['providers', 'preloads', 'commands'] as const) {
        assert.deepEqual(
          rc[field].map((entry) => entry.specifier),
          [null, null]
        )
        assert.lengthOf(
          result.limitations.filter((message) => message.startsWith(`${field}:`)),
          1
        )
      }
      assert.deepEqual(result.data.manifest, {
        dependencies: { 'csrf-tokens': '^1.2.3', '@aws-sdk/credential-providers': '^3.0.0' },
        devDependencies: { probe: 'git+https://[REDACTED]@github.com/o/r.git' },
        peerDependencies: { probe: 'https://reg/p?token=[REDACTED]' },
        optionalDependencies: { probe: 'https://[REDACTED]@reg/p' },
        scripts: { authToken: 'npm run test' },
      })
    })
  }
})
