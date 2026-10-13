import vine, { SimpleMessagesProvider } from '@vinejs/vine'

const startsProbe = vine.createRule((value, _options, field) => {
  if (typeof value === 'string' && !value.startsWith('probe')) field.report('Must start probe', 'startsProbe', field)
}, { name: 'startsProbe' })
export const probeValidator = vine.compile(vine.object({
  title: vine.string().minLength(3),
  profile: vine.object({ age: vine.number().min(18), nickname: vine.string().optional() }),
  items: vine.array(vine.object({ code: vine.string().nullable() })).minLength(1),
  custom: vine.string().use(startsProbe()),
  choice: vine.union([
    vine.union.if((value) => typeof value === 'string', vine.string().minLength(2)),
    vine.union.else(vine.number()),
  ]),
}).merge(vine.group([
  vine.group.if((value) => value.title === 'company', { company: vine.string() }),
  vine.group.else({ person: vine.string().optional() }),
])))
probeValidator.messagesProvider = new SimpleMessagesProvider({ 'title.minLength': 'TITLE_TOO_SHORT' }, { title: 'Judul' })
export const revision = 'before'
