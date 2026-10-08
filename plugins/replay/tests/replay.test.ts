import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { countsOf, hunkOf, shortOf, unifiedOf } from '../hooks/diff'

const PANE = {
  component: 'Pane',
  requestId: 'replay',
  props: { title: 'Wiedergabe', placement: 'dock', isFocused: true, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const PATCH = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] }]

// the engine beneath the mod: edits "run" and answer with the engine's own records
const engine = (on: On) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, null))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', () => ({ cwd: '/p' }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit') {
      return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: null, structuredPatch: PATCH, userModified: false, replaceAll: false } }
    }
    if (e.tool === 'Write') {
      return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
    }
    return { result: { stdout: '', stderr: '' } }
  })
}

const turn = async ($: { turn: { start: (e: { text: string; turnId: string }) => Promise<unknown>; complete: (e: { answer: string; durationMs: number; isAborted: boolean; turnId: string; reason: 'answer' }) => Promise<unknown> } }, body: () => Promise<void>) => {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await body()
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

describe('diff', () => {
  test('a structured patch reads as a unified diff', async () => {
    expect(unifiedOf(PATCH)).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c')
    expect(countsOf(unifiedOf(PATCH))).toEqual({ added: 1, removed: 1 })
  })

  test('a hunk of its own trims the unchanged head and tail', async () => {
    expect(hunkOf('a\nb\nc', 'a\nx\nc')).toEqual([{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+x'] }])
    expect(hunkOf('', 'new\nfile')).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+new', '+file'] }])
    expect(hunkOf('same', 'same')).toEqual([])
  })

  test('long paths are shortened to their tail', async () => {
    expect(shortOf('/home/user/proj/src/app.ts')).toBe('…/proj/src/app.ts')
    expect(shortOf('src/app.ts')).toBe('src/app.ts')
  })
})

describe('the replay', () => {
  test('/replay with no edits says so', async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup' } as never)
    const out = await $.command.run({ command: 'replay', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    expect(out.text).toBe('Keine Dateiänderungen in der letzten Runde (no edits in the last turn).')
  })

  test("a turn's edits replay in order, and the buttons walk them", async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup' } as never)
    await turn($, async () => {
      await $.tool.call({ tool: 'Edit', file_path: '/p/src/a.ts', old_string: 'b', new_string: 'c' })
      await $.tool.call({ tool: 'Write', file_path: '/p/src/new.ts', content: 'hello\nworld' })
      await $.tool.call({ tool: 'Bash', command: 'ls' })
    })
    const out = await $.command.run({ command: 'replay', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    expect(out.text).toBe('Wiedergabe (replay): 2 Änderungen der letzten Runde.')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'replay', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: 'Schritt (step) 1/2' })).toBeDefined()
      expect(await ui.find({ type: 'Code', text: /-b\n\+c/ })).toBeDefined()
      await ui.press({ key: 'next' })
      expect(await ui.find({ type: 'Text', text: 'Schritt (step) 2/2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '(neu (new))' })).toBeDefined()
      expect(await ui.find({ type: 'Code', text: /\+hello\n\+world/ })).toBeDefined()
      await ui.press({ key: 'next' }) // stays on the last step
      expect(await ui.find({ type: 'Text', text: 'Schritt (step) 2/2' })).toBeDefined()
      await ui.press({ key: 'prev' })
      expect(await ui.find({ type: 'Text', text: 'Schritt (step) 1/2' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a new turn with edits replaces the replay; one without leaves it', async ($, on) => {
    engine(on)
    await turn($, async () => {
      await $.tool.call({ tool: 'Edit', file_path: '/p/one.ts', old_string: 'b', new_string: 'c' })
    })
    await turn($, async () => {
      await $.tool.call({ tool: 'Bash', command: 'ls' })
    })
    const ui = await $.ui.mount({ plugin: 'replay', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /one\.ts/ })).toBeDefined()
    await ui.unmount()
    await turn($, async () => {
      await $.tool.call({ tool: 'Edit', file_path: '/p/two.ts', old_string: 'b', new_string: 'c' })
    })
    const again = await $.ui.mount({ plugin: 'replay', surface: 'terminal', ...PANE })
    expect(await again.find({ type: 'Text', text: /two\.ts/ })).toBeDefined()
    expect(await again.find({ type: 'Text', text: 'Schritt (step) 1/1' })).toBeDefined()
  })
})
