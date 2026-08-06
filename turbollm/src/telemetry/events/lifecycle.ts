/** App-lifecycle events (spec 24, ADR-333). Unchanged from ADR-299 Decision 6. */

import { defineEvent } from '../core/define'

export const appFirstRun = defineEvent({
  name: 'app_first_run',
  since: 1,
  consent: 'anon',
  lifecycle: 'once',
  description: 'The daemon has run for the first time ever on this install.',
})

export const dailyActive = defineEvent({
  name: 'daily_active',
  since: 1,
  consent: 'anon',
  lifecycle: 'once-daily',
  description: 'This machine was active at least once today.',
})
