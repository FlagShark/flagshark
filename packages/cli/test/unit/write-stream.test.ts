import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { writeStream } from '../../src/write-stream.js'

describe('writeStream', () => {
  it('waits for a backpressured write callback', async () => {
    let flushed = false
    const writable = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setImmediate(() => {
          flushed = true
          callback()
        })
      },
    })
    const writing = writeStream(writable, new Uint8Array(1024))
    expect(flushed).toBe(false)
    await writing
    expect(flushed).toBe(true)
  })

  it('rejects an emitted write error and ignores a later callback', async () => {
    const events = new EventEmitter()
    const writable = Object.assign(events, {
      write(_chunk: unknown, callback: (error?: Error) => void) {
        events.emit('error', new Error('pipe closed'))
        callback(new Error('late callback'))
        return false
      },
    }) as unknown as NodeJS.WritableStream
    await expect(writeStream(writable, 'report')).rejects.toThrow('pipe closed')
  })

  it('rejects callback errors', async () => {
    const events = new EventEmitter()
    const writable = Object.assign(events, {
      write(_chunk: unknown, callback: (error?: Error) => void) {
        callback(new Error('write failed'))
        return false
      },
    }) as unknown as NodeJS.WritableStream
    await expect(writeStream(writable, 'report')).rejects.toThrow('write failed')
  })

  it.each([new Error('sync failure'), 'non-error failure'])('normalizes synchronous throw %#', async (thrown) => {
    const events = new EventEmitter()
    const writable = Object.assign(events, {
      write: vi.fn(() => { throw thrown }),
    }) as unknown as NodeJS.WritableStream
    await expect(writeStream(writable, 'report')).rejects.toThrow(String(
      thrown instanceof Error ? thrown.message : thrown,
    ))
  })
})
