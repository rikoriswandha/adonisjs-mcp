import { defineTenantAuthConfig, tenantGuards } from '@rikology/adonisjs-tenant/guards'
import { TenantUserProvider } from '@rikology/adonisjs-tenant/user_providers'
import { tokensUserProvider } from '@adonisjs/auth/access_tokens'
import { sessionUserProvider } from '@adonisjs/auth/session'
import User from '#models/user'
export default defineTenantAuthConfig({
  default: 'api',
  guards: {
    api: tenantGuards.accessTokens({
      provider: tokensUserProvider({ tokens: 'accessTokens', model: () => import('#models/user') }),
      tenantTokenProvider: User.accessTokens,
    }),
    web: tenantGuards.session({
      provider: sessionUserProvider({ model: () => import('#models/user') }),
      tenantProvider: new TenantUserProvider(User, { pivotTable: 'tenant_user' }),
    }),
  },
})
