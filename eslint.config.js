import { configPkg } from '@adonisjs/eslint-config'

export default configPkg({
  ignores: ['build/**', 'tests/fixtures/apps/**', 'spikes/**'],
})
