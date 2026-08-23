import { describe, expect, it, vi } from 'vitest'
import { panelFace, RewindRemoteError } from '../src/client/controller.ts'

describe('conversation rewind controller', () => {
  it('rejects immediately when the caller is already aborted', async () => {
    const list = vi.fn()
    const face = panelFace({} as never, () => ({ list, rewind: vi.fn(), select: vi.fn() }))
    const controller = new AbortController()
    controller.abort()

    await expect(face.load('session' as never, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(list).not.toHaveBeenCalled()
  })

  it('unwraps a successful same-Session result', async () => {
    const value = {
      sessionId: 'session', replacementSeq: 9, queuedMessages: 1, shadowedMessages: 4,
    }
    const rewind = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value } }))
    const face = panelFace({} as never, () => ({ list: vi.fn(), rewind, select: vi.fn() }))
    const request = {
      sessionId: 'session', messageSeq: 4, text: 'edited', cascade: 'truncate' as const,
    }
    const signal = new AbortController().signal

    await expect(face.create(request, signal)).resolves.toEqual(value)
    expect(rewind).toHaveBeenCalledWith(request, signal)
  })

  it('preserves partial same-Session details from a business error', async () => {
    const rewind = vi.fn(async () => ({
      ok: true as const,
      value: {
        ok: false as const,
        error: {
          code: 'REWIND_PARTIAL',
          message: 'checkpoint failed',
          sessionId: 'session',
          replacementSeq: 9,
        },
      },
    }))
    const face = panelFace({} as never, () => ({ list: vi.fn(), rewind, select: vi.fn() }))

    await expect(face.create({
      sessionId: 'session', messageSeq: 4, text: 'edited', cascade: 'truncate',
    }, new AbortController().signal)).rejects.toSatisfy((error: unknown) => (
      error instanceof RewindRemoteError
      && error.code === 'REWIND_PARTIAL'
      && error.sessionId === 'session'
      && error.replacementSeq === 9
    ))
  })

  it('unwraps a same-Session branch selection', async () => {
    const value = { sessionId: 'session', messageSeq: 4, path: [1, 4], queuedMessages: 0 }
    const select = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value } }))
    const face = panelFace({} as never, () => ({ list: vi.fn(), rewind: vi.fn(), select }))
    const request = { sessionId: 'session', messageSeq: 4 }
    const signal = new AbortController().signal

    await expect(face.select(request, signal)).resolves.toEqual(value)
    expect(select).toHaveBeenCalledWith(request, signal)
  })
})
