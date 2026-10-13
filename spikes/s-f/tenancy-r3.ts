import { defineTenancyConfig } from '@rikology/adonisjs-tenant'
export default defineTenancyConfig({
  default: 'probe', failOnMissing: true,
  tenants: { probe: { resolver: 'header', options: { header: 'X-Tenant-ID', tenants: {
    a: { id: 'a', name: 'Tenant A', slug: 'a' },
    b: { id: 'b', name: 'Tenant B', slug: 'b' },
  } } } },
})
