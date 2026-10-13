import { definePermissions } from '@adonisplus/permissions'
export const permissions = definePermissions({ invoice: { view: 'View invoices', refund: true, legacy: { inactive: true, aliases: ['invoice.old'] } } })
