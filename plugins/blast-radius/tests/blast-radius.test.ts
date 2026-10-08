import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify } from '../hooks/classify'
import { countOf, measure, sizeOf } from '../hooks/measure'

const PANE = {
  component: 'Pane',
  requestId: 'blast-radius',
  props: { title: 'Blast Radius', placement: 'dock', isFocused: true, bodyColumns: 80, bodyRows: 20, scroll: { offset: 0, bodyRows: 20 } },
} as const

// canned answers for the read-only commands the mod runs
const OUTPUT: Record<string, string> = {
  'du -sk -- build': '2400\tbuild\n',
  'find build': 'build\nbuild/a.js\nbuild/b.js\n',
  'git status --porcelain': ' M src/app.ts\n M README.md\n?? scratch.txt\n',
  'git clean -n -dx': 'Would remove dist/\nWould remove .cache/\n',
}

const RESULT = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// the engine beneath the mod: a session with one surface, a pane that is placed, the Bash tool that "runs".
// The mod's quarter-second pauses wait here until the test lets time pass (`tick`), as a real clock would.
function engine(on: On, ran: string[], isPlaced = true) {
  let waiting: (() => void)[] = []
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'sleep') return new Promise(resolve => waiting.push(() => resolve(RESULT(''))))
    const out = OUTPUT[e.argv.join(' ')]
    return RESULT(out ?? '', out === undefined ? 1 : 0)
  })
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, null))
  on('tool.call', ($, e) => {
    ran.push(String((e as { command?: string }).command))
    return { result: { stdout: 'ok', stderr: '' } }
  })
  return {
    tick: () => {
      const now = waiting
      waiting = []
      now.forEach(go => go())
    },
  }
}

type Drawing = { find: (q: { type: string; text: RegExp }) => Promise<unknown>; drawn: () => Promise<unknown> }

// waits until the drawing shows `text`, as the person would see the card appear
async function shown(ui: Drawing, text: RegExp) {
  for (let i = 0; i < 200; i++) {
    if (await ui.find({ type: 'Text', text })) return
    await ui.drawn()
  }
  throw new Error(`never shown: ${text}`)
}

// lets time pass until the held call settles
async function settle<T>(call: Promise<T>, tick: () => void, ui: Drawing): Promise<T> {
  let done = false
  void call.then(() => (done = true), () => (done = true))
  for (let i = 0; i < 200 && !done; i++) {
    tick()
    await ui.drawn() // a round trip lets the hook take its next step
  }
  return call
}

describe('classify', () => {
  test('finds the commands that destroy', async () => {
    expect(classify('rm -rf build')?.kind).toBe('rm')
    expect(classify('rm -r -- a b')?.args).toEqual(['a', 'b'])
    expect(classify('npm test && git reset --hard HEAD~2')?.kind).toBe('git-reset-hard')
    expect(classify('git clean -fdx')?.kind).toBe('git-clean')
    expect(classify('git checkout -- .')?.kind).toBe('git-discard')
    expect(classify('git restore src/app.ts')?.kind).toBe('git-discard')
    expect(classify('git push --force origin main')?.kind).toBe('git-push-force')
    expect(classify('git push -f')?.kind).toBe('git-push-force')
    expect(classify('git branch -D old')?.args).toEqual(['old'])
    expect(classify('sudo rm -rf /tmp/x')?.kind).toBe('rm')
    expect(classify('find . -name "*.log" -delete')?.kind).toBe('find-delete')
  })

  test('lets everything else through', async () => {
    expect(classify('rm file.txt')).toBeNull()
    expect(classify('ls -la && git status')).toBeNull()
    expect(classify('git restore --staged src/app.ts')).toBeNull()
    expect(classify('git push origin main')).toBeNull()
    expect(classify('git branch -d merged')).toBeNull()
    expect(classify('echo "rm -rf /"')).toBeNull()
  })
})

describe('measure', () => {
  const run = async (argv: string[]) => OUTPUT[argv.join(' ')] ?? null

  test('counts what rm would delete', async () => {
    const report = await measure(run, classify('rm -rf build')!, '/work')
    expect(report.summary).toBe('würde 3 Dateien und Ordner (2,3 MB) unwiderruflich löschen (delete for good)')
    expect(report.severity).toBe('high')
  })

  test('the whole project or home is critical', async () => {
    expect((await measure(run, classify('rm -rf .')!, '/work')).severity).toBe('critical')
    expect((await measure(run, classify('rm -rf ~')!, '/work')).severity).toBe('critical')
  })

  test('git clean is measured by its own dry run', async () => {
    const report = await measure(run, classify('git clean -fdx')!, '/work')
    expect(report.summary).toBe('würde 2 ungetrackte Dateien und Ordner löschen (delete untracked files)')
    expect(report.lines).toEqual(['dist/', '.cache/'])
  })

  test('git reset --hard counts tracked changes, not untracked files', async () => {
    const report = await measure(run, classify('git reset --hard')!, '/work')
    expect(report.summary).toBe('würde ungespeicherte Änderungen in 2 Dateien verwerfen (discard unsaved changes)')
    expect(report.severity).toBe('critical')
  })

  test('numbers read the German way', async () => {
    expect(countOf(12345)).toBe('12.345')
    expect(sizeOf(2_400_000)).toBe('2,3 GB')
  })
})

describe('the hold', () => {
  test('a harmless command runs without a pane', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(ran).toEqual(['ls -la'])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`Abbrechen keeps the command from running (${surface})`, async ($, on) => {
      const ran: string[] = []
      const { tick } = engine(on, ran)
      const ui = await $.ui.mount({ plugin: 'blast-radius', surface, ...PANE })
      const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
      await shown(ui, /Rekursives Löschen \(recursive delete\) angehalten/)
      expect(await ui.find({ type: 'Text', text: /3 Dateien und Ordner \(2,3 MB\)/ })).toBeDefined()
      const pressed = ui.press({ key: 'cancel' })
      const result = await settle(call, tick, ui)
      await pressed
      expect(ran).toEqual([])
      expect(JSON.stringify(result)).toContain('Abbrechen')
    })

    test(`Trotzdem ausführen lets it run (${surface})`, async ($, on) => {
      const ran: string[] = []
      const { tick } = engine(on, ran)
      const ui = await $.ui.mount({ plugin: 'blast-radius', surface, ...PANE })
      const call = $.tool.call({ tool: 'Bash', command: 'git clean -fdx' })
      await shown(ui, /git clean angehalten \(held\)/)
      const pressed = ui.press({ key: 'proceed' })
      await settle(call, tick, ui)
      await pressed
      expect(ran).toEqual(['git clean -fdx'])
      expect(await ui.find({ type: 'Text', text: /Kein Befehl angehalten \(nothing held\)/ })).toBeDefined()
    })
  }

  test('where no pane fits, the card is drawn above the prompt', async ($, on) => {
    const ran: string[] = []
    const { tick } = engine(on, ran, false)
    const band = await $.ui.mount({
      plugin: 'blast-radius',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    const call = $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    await shown(band, /2 Dateien verwerfen/)
    const pressed = band.press({ key: 'cancel' })
    await settle(call, tick, band)
    await pressed
    expect(ran).toEqual([])
  })
})
