import type { HttpContext } from '@adonisjs/core/http'

// Discovery specimen only: the runner does not request these routes.
export default class PagesController {
  static({ inertia }: HttpContext) {
    return inertia.render('s_i', { label: 'static', count: 1 })
  }
  dynamic({ inertia, request }: HttpContext) {
    const page = request.input('page')
    const props = request.input('props')
    return inertia.render(page, { ...props, label: 'dynamic' })
  }
}
