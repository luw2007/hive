import type { PtyOutputBus } from './pty-output-bus.js'

const COMPACT_PATTERNS = [
  /auto-?compacting/i,
  /conversation compacted/i,
  /context.*truncat/i,
  /summarizing conversation/i,
]

const IDLE_TIMEOUT_MS = 30_000

interface RunState {
  compactDetected: boolean
  idleCallbacks: Set<() => void>
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface CompactDetector {
  attach: (runId: string) => () => void
  isCompactDetected: (runId: string) => boolean
  onIdle: (runId: string, callback: () => void) => () => void
}

export const createCompactDetector = (bus: PtyOutputBus): CompactDetector => {
  const states = new Map<string, RunState>()

  const getState = (runId: string): RunState => {
    let state = states.get(runId)
    if (!state) {
      state = { compactDetected: false, idleCallbacks: new Set(), idleTimer: null }
      states.set(runId, state)
    }
    return state
  }

  const resetIdleTimer = (state: RunState) => {
    if (state.idleTimer) clearTimeout(state.idleTimer)
    if (!state.compactDetected) return
    state.idleTimer = setTimeout(() => {
      for (const cb of state.idleCallbacks) cb()
    }, IDLE_TIMEOUT_MS)
  }

  return {
    attach(runId) {
      const state = getState(runId)
      const unsubscribe = bus.subscribe(runId, (chunk) => {
        if (!state.compactDetected) {
          for (const pattern of COMPACT_PATTERNS) {
            if (pattern.test(chunk)) {
              state.compactDetected = true
              resetIdleTimer(state)
              return
            }
          }
        } else {
          resetIdleTimer(state)
        }
      })
      return () => {
        unsubscribe()
        if (state.idleTimer) clearTimeout(state.idleTimer)
        states.delete(runId)
      }
    },
    isCompactDetected(runId) {
      return states.get(runId)?.compactDetected ?? false
    },
    onIdle(runId, callback) {
      const state = getState(runId)
      state.idleCallbacks.add(callback)
      return () => { state.idleCallbacks.delete(callback) }
    },
  }
}
