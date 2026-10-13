import { fileURLToPath } from 'node:url'
export async function configure(command) {
  const codemods = await command.createCodemods()
  const safe = process.env.SB_STRATEGY === 'safe'
  await codemods.updateRcFile((rc) => rc.addProvider(safe ? '#providers/mcp_dev_provider' : '@rikology/adonisjs-mcp/providers/mcp_provider', ['web']))
  const root = fileURLToPath(new URL('./stubs/', import.meta.url))
  await codemods.makeUsingStub(root, safe ? 'config/safe.stub' : 'config/unsafe.stub', {})
  if (safe) await codemods.makeUsingStub(root, 'providers/wrapper.stub', {})
  await codemods.makeUsingStub(root, 'providers/observer.stub', {})
  await codemods.updateRcFile((rc) => rc.addProvider('#providers/sb_observer_provider'))
}
