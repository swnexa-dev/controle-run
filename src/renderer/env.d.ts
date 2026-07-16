import type { ControleRunApi } from '../shared/types'

declare global {
  interface Window { controleRun: ControleRunApi }
}

export {}
