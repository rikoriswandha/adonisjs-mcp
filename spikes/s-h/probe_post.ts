import { BaseModel, column } from '@adonisjs/lucid/orm'
import { TenantScope } from '@rikology/adonisjs-tenant/mixins'

export default class ProbePost extends TenantScope(BaseModel) {
  static table = 'sh_posts'
  @column({ isPrimary: true }) declare id: number
  @column() declare title: string
  @column() declare overlap: number
}
