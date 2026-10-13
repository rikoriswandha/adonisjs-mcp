import router from '@adonisjs/core/services/router'
import config from '@adonisjs/core/services/config'
import { probeValidator, revision } from '#validators/probe_validator'
import ProbeTransformer from '../app/transformers/probe_transformer.js'

router.get('/__s_i', async () => {
  const compiled = probeValidator.toJSON()
  return {
    pid: process.pid, revision,
    compiled: compiled.schema,
    refs: JSON.parse(JSON.stringify(compiled.refs, (_key, value) =>
      typeof value === 'function' ? { kind: 'function', name: value.name } : value)),
    jsonSchema: probeValidator.toJSONSchema(),
    messages: probeValidator.messagesProvider.toJSON(),
    transformed: new ProbeTransformer({ id: 1 }).toObject(),
    inertia: config.has('inertia') ? { configKeys: Object.keys(config.get('inertia')), ssr: config.get('inertia.ssr') } : null,
  }
}).as('s_i.inspect')
