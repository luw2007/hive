import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCompactDetector } from '../../src/server/compact-detector.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'

describe('compact-detector', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('detects "auto-compacting" in PTY output', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-1')

    bus.publish('run-1', 'some normal output')
    expect(detector.isCompactDetected('run-1')).toBe(false)

    bus.publish('run-1', '[info] auto-compacting conversation...')
    expect(detector.isCompactDetected('run-1')).toBe(true)
  })

  it('detects "conversation compacted"', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-2')

    bus.publish('run-2', 'Conversation compacted successfully')
    expect(detector.isCompactDetected('run-2')).toBe(true)
  })

  it('detects "context truncat" pattern', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-3')

    bus.publish('run-3', 'context was truncated due to length')
    expect(detector.isCompactDetected('run-3')).toBe(true)
  })

  it('detects "summarizing conversation"', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-4')

    bus.publish('run-4', 'summarizing conversation history...')
    expect(detector.isCompactDetected('run-4')).toBe(true)
  })

  it('does not trigger on unrelated output', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-5')

    bus.publish('run-5', 'compiling source files...')
    bus.publish('run-5', 'tests passed: 42/42')
    bus.publish('run-5', 'contextual information about the project')
    expect(detector.isCompactDetected('run-5')).toBe(false)
  })

  it('idle callback fires after 30s of no output following detection', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-6')

    const idleFn = vi.fn()
    detector.onIdle('run-6', idleFn)

    bus.publish('run-6', 'auto-compacting...')
    expect(detector.isCompactDetected('run-6')).toBe(true)
    expect(idleFn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(29_000)
    expect(idleFn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_000)
    expect(idleFn).toHaveBeenCalledTimes(1)
  })

  it('idle timer resets when new output arrives after detection', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    detector.attach('run-7')

    const idleFn = vi.fn()
    detector.onIdle('run-7', idleFn)

    bus.publish('run-7', 'auto-compacting...')
    vi.advanceTimersByTime(20_000)
    bus.publish('run-7', 'still working...')
    vi.advanceTimersByTime(20_000)
    expect(idleFn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(11_000)
    expect(idleFn).toHaveBeenCalledTimes(1)
  })

  it('isCompactDetected returns false for unknown runId', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    expect(detector.isCompactDetected('nonexistent')).toBe(false)
  })

  it('unsubscribe from attach cleans up state', () => {
    const bus = createPtyOutputBus()
    const detector = createCompactDetector(bus)
    const detach = detector.attach('run-8')

    bus.publish('run-8', 'auto-compacting...')
    expect(detector.isCompactDetected('run-8')).toBe(true)

    detach()
    expect(detector.isCompactDetected('run-8')).toBe(false)
  })
})
