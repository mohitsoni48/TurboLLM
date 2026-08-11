import type { ProfileId } from './state'

export type Role = 'general' | 'coder'

/** Spec 25 §5.2. `pro` deliberately maps to NO role: it takes the Discover
 *  handoff and picks its own model and quant, on every tier including T0. */
export function roleFor(profile: ProfileId): Role | null {
  switch (profile) {
    case 'casual':
    case 'enthusiast':
      return 'general'
    case 'developer':
      return 'coder'
    case 'pro':
      return null
  }
}
