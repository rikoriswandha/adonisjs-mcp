import { BaseTransformer } from '@adonisjs/core/transformers'
export default class ProbeTransformer extends BaseTransformer<{ id: number }> {
  toObject() { return { id: this.resource.id, revision: 'before' } }
}
