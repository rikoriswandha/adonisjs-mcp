import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { withTenantAuthFinder } from '@rikology/adonisjs-tenant/mixins'
export default class User extends withTenantAuthFinder(() => hash.use(), {
  uids: ['email'], passwordColumnName: 'password', membership: { pivotTable: 'tenant_user' },
})(UserSchema) {}
