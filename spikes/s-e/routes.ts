import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import User from '#models/user'
import { evaluate, completions } from '@spike/eval'
router.get('/__spike/eval', async ({ request }) => evaluate(JSON.parse(request.input('payload')), app, User))
router.get('/__spike/state', () => ({ completions, marker: User.spikeMarker, pid: process.pid }))
router.get('/__spike/controller', [() => import('#controllers/spike_eval_controller'), 'handle'])
