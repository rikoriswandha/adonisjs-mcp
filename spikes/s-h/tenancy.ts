import { defineTenancyConfig } from '@rikology/adonisjs-tenant'

const tenants = {
  a: { id: 'a', name: 'Tenant A', slug: 'a' },
  b: { id: 'b', name: 'Tenant B', slug: 'b' },
}
export default defineTenancyConfig({
  default: 'probe',
  failOnMissing: true,
  tenants: {
    probe: process.env.SH_RESOLVER === 'subdomain'
      ? { resolver: 'subdomain', options: { tenants } }
      : { resolver: 'header', options: { header: 'X-Tenant-ID', tenants } },
  },
})
