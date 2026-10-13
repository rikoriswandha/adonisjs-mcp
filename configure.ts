/*
 * Installs the production-safe development gateway. Optional source edits are
 * conservative: unfamiliar app configurations receive manual instructions.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Configure from '@adonisjs/core/commands/configure'
import type { PropertyAssignment, ShorthandPropertyAssignment, StringLiteral } from 'ts-morph'
import { stubsRoot } from './stubs/main.js'
import {
  instrumentExceptions,
  instrumentLogger,
  vmModulesScript,
} from './src/configure/instrument.js'

export async function configure(command: Configure) {
  const manifestPath = command.app.makePath('package.json')
  const manifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText) as {
    imports?: Record<string, string>
    scripts?: Record<string, string>
  }
  if (!manifest.imports?.['#providers/*']) {
    throw new Error(
      'Cannot configure @rikology/adonisjs-mcp: add "#providers/*": "./providers/*.js" to package.json imports first.'
    )
  }
  const pending: string[] = []
  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/mcp.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'providers/mcp_dev_provider.stub', {})
  await codemods.updateRcFile((rcFile) =>
    rcFile.addProvider('#providers/mcp_dev_provider', ['web'])
  )

  const instrumentFlag = command.parsedFlags.instrument
  const instrument =
    typeof instrumentFlag === 'boolean'
      ? instrumentFlag
      : process.stdin.isTTY
        ? await command.prompt.confirm('Enable MCP log and exception capture?', { default: true })
        : false
  if (instrument && !manifest.imports?.['#start/*']) {
    pending.push(
      'Capture instrumentation skipped: add "#start/*": "./start/*.js" to package.json imports, then rerun configure with --instrument.'
    )
  } else if (instrument) {
    const gatewayPath = command.app.makePath('start/mcp_dev_hooks.ts')
    const writesGateway = !existsSync(gatewayPath) || command.force
    await codemods.makeUsingStub(stubsRoot, 'start/mcp_dev_hooks.stub', {})
    // Tempura strips trailing whitespace; retain the gateway's canonical final newline.
    if (writesGateway) {
      const gateway = await readFile(gatewayPath, 'utf8')
      if (!gateway.endsWith('\n')) await writeFile(gatewayPath, `${gateway}\n`)
    }
    const project = await codemods.getTsMorphProject()
    for (const [file, transform, instruction] of [
      [
        'config/logger.ts',
        instrumentLogger,
        "Import streamWrite from '#start/mcp_dev_hooks' and add it to the default logger hooks (compose existing hooks).",
      ],
      [
        'app/exceptions/handler.ts',
        instrumentExceptions,
        "Import observeException from '#start/mcp_dev_hooks' and call observeException(error, ctx) first in handle().",
      ],
    ] as const) {
      const path = command.app.makePath(file)
      const source = project && existsSync(path) ? project.addSourceFileAtPath(path) : undefined
      if (source && transform(source)) {
        if (source.getFullText() !== (await readFile(path, 'utf8'))) await source.save()
      } else pending.push(`${file}: ${instruction}`)
    }
  } else if (instrumentFlag === undefined) {
    pending.push(
      'Capture instrumentation skipped: rerun configure with --instrument (or explicitly opt out with --no-instrument).'
    )
  }

  const vmFlag = command.parsedFlags['vm-modules'] ?? command.parsedFlags.vmModules
  const vmModules =
    typeof vmFlag === 'boolean'
      ? vmFlag
      : process.stdin.isTTY
        ? await command.prompt.confirm('Enable --experimental-vm-modules for project_eval?', {
            default: true,
          })
        : false
  if (vmModules) {
    const script = manifest.scripts?.dev
    const updated = script ? vmModulesScript(script) : undefined
    if (updated === undefined)
      pending.push(
        process.platform === 'win32'
          ? 'Enable --experimental-vm-modules via NODE_OPTIONS in your Windows development launch environment manually; scripts.dev was not rewritten.'
          : 'Set NODE_OPTIONS=--experimental-vm-modules in your development launch environment for project_eval (scripts.dev is absent or already sets NODE_OPTIONS).'
      )
    else if (updated !== script) {
      manifest.scripts!.dev = updated
      const indentation = manifestText.match(/^[ \t]+(?=\S)/m)?.[0] ?? 2
      const trailingNewline = manifestText.match(/(?:\r?\n)+$/)?.[0] ?? ''
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, indentation)}${trailingNewline}`
      )
    }
  } else if (vmFlag === undefined) {
    pending.push(
      'VM modules skipped: rerun configure with --vm-modules (or explicitly opt out with --no-vm-modules).'
    )
  }

  const claudeRoot = command.app.makePath('.claude')
  if (existsSync(claudeRoot)) {
    const target = join(claudeRoot, 'skills/adonisjs-mcp/SKILL.md')
    const source = join(stubsRoot, '../../skills/adonisjs-mcp/SKILL.md')
    if (!existsSync(target) || command.force) {
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
    }
  }

  let port = '3333'
  const envPath = command.app.makePath('.env')
  if (existsSync(envPath)) {
    const env = await readFile(envPath, 'utf8')
    const portLine = env.match(/^PORT\s*=(.*)$/m)
    if (portLine) {
      const integer = portLine[1].trim().match(/^\d+$/)?.[0]
      if (integer) port = integer
      else
        pending.push(
          'The .env PORT value is not a plain integer: substitute the actual port for 3333 in the URL below (3333 is the default).'
        )
    } else pending.push('No .env PORT setting found; the URL uses the default port 3333.')
  } else pending.push('No .env file found; the URL uses the default port 3333.')
  const configPath = command.app.makePath('config/mcp.ts')
  const project = await codemods.getTsMorphProject()
  const configSource = project?.addSourceFileAtPath(configPath)
  const pathProperty = configSource
    ?.getDescendants()
    .find(
      (node) =>
        ['PropertyAssignment', 'ShorthandPropertyAssignment'].includes(node.getKindName()) &&
        (node as PropertyAssignment | ShorthandPropertyAssignment)
          .getName()
          .replace(/^['"]|['"]$/g, '') === 'path'
    )
  const initializer =
    pathProperty?.getKindName() === 'PropertyAssignment'
      ? (pathProperty as PropertyAssignment).getInitializer()
      : undefined
  const path =
    initializer?.getKindName() === 'StringLiteral'
      ? (initializer as StringLiteral).getLiteralValue()
      : '/__adonis/mcp'
  if (!configSource || (pathProperty && initializer?.getKindName() !== 'StringLiteral')) {
    pending.push(
      'The config/mcp.ts path is not a literal string: substitute the actual MCP path for /__adonis/mcp in the URL below.'
    )
  }
  const instructions = command.ui.instructions().heading('AdonisJS MCP next steps')
  instructions.add(`claude mcp add --transport http adonis http://localhost:${port}${path}`)
  instructions.add('See the package README for other MCP client recipes.')
  for (const instruction of pending) instructions.add(instruction)
  instructions.render()
}
