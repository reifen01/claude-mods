import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Held } from '../types'
import { classify } from './classify'
import { measure } from './measure'
import type { Run } from './measure'

const PANE = 'blast-radius'
const held = atom({ plugin: 'blast-radius', key: 'held' } as const, null)

// a $ call's wait is free of the hook's 10 s budget (a clock.sleep is not): this is how the hook waits for a press
const pause = ($: EngineInterface) => $.process.run(['sleep', '0.25']).catch(() => undefined)

// ten minutes of pauses with no answer is a Cancel: a held command never waits forever
const MAX_PAUSES = 2400

type Answer = 'proceed' | 'cancel'

// The answer lives in the module, not in $.state: a hook that is still running reads $.state as it was when its
// dispatch began, so it would never see a press. `waiting` is the id of the held call, `answer` what was pressed.
let waiting: string | null = null
let answer: Answer | null = null

// the press writes the module's answer for the hook, and $.state for the drawing (the card shows it was answered)
const decide = ($: EngineInterface, decision: Answer) => {
  if (waiting !== null && answer === null) answer = decision
  return update($, held, cur => (cur && cur.decision === null ? { ...cur, decision } : cur))
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const risk = classify(command)
    if (risk === null) return next(e) // everything else runs as normal

    // nobody to press a button (claude -p): say so and let it run, as without the mod
    if ((await $.session.surfaces()).length === 0) {
      $.ui.log(`blast-radius: ${risk.label} ohne Rückfrage ausgeführt (keine Oberfläche)`, { to: 'debug' })
      return next(e)
    }

    // one held command at a time: a second waits until the first is answered
    for (let i = 0; waiting !== null && i < MAX_PAUSES && !next.signal.aborted; i++) await pause($)
    if (waiting !== null) return { deny: 'Blast Radius: ein anderer Befehl wartet noch auf eine Antwort.' }
    waiting = e.tool_use_id
    answer = null

    const cwd = await $.session.cwd()
    // a failed or slow measurement is a line in the report, never a reason to let the command through
    const run: Run = argv =>
      $.process
        .run(argv, { cwd, timeoutMs: 5000 })
        .then(r => (r.exitCode === 0 ? r.stdout : null))
        .catch(() => null)
    const report = await measure(run, risk, cwd)
    const opened = await $.ui.open({ id: PANE, title: 'Blast Radius', focus: true, closeOnEscape: true, holdToasts: true })
    const where: Held['where'] = opened.isPlaced ? 'pane' : 'band' // too narrow for a pane: draw above the prompt
    await update($, held, () => ({ id: e.tool_use_id, command, risk, report, where, decision: null }))

    for (let i = 0; answer === null && i < MAX_PAUSES && !next.signal.aborted; i++) await pause($)
    const decision = answer // null when time ran out or the turn was interrupted: a Cancel
    waiting = null
    answer = null
    await update($, held, () => null)
    await $.ui.close({ id: PANE }).catch(() => undefined)

    if (decision === 'proceed') return next(e) // let it run
    return {
      deny:
        `Blast Radius hat diesen Befehl angehalten, die Person hat „Abbrechen“ gewählt. ` +
        `Er ${report.summary}. Nicht auf anderem Weg wiederholen, ohne vorher nachzufragen.`,
    }
  }).catch(($, e, next) => {
    // a guard that broke before asking holds the command rather than letting it through unseen
    if (waiting === e.tool_use_id) {
      waiting = null
      answer = null
    }
    return next.called ? next(e) : { deny: 'Blast Radius konnte diesen Befehl nicht prüfen und hat ihn angehalten.' }
  })

  // the person closing the pane (✕ or Esc) is a Cancel
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await decide($, 'cancel')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const cur = await read($, held)
    const { Text } = $.ui.resolve(e)
    return cur ? card($, e, cur) : <Text dimColor>Kein Befehl angehalten.</Text>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cur = await read($, held)
    if (!cur || cur.where !== 'band' || cur.decision !== null) return next(e)
    const mine = card($, e, cur)
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    )
  })
}

function card($: EngineInterface, e: RenderInput, it: Held) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const color = it.report.severity === 'critical' ? 'red' : 'yellow'
  const summary = it.report.summary.charAt(0).toUpperCase() + it.report.summary.slice(1)
  return (
    <Box key="blast-radius" flexDirection="column">
      <Text color={color} bold>{`⚠ ${it.risk.label} angehalten`}</Text>
      <Text wrap="truncate-end">{`$ ${it.command}`}</Text>
      <Text bold>{summary}</Text>
      {it.report.lines.map(line => (
        <Text dimColor wrap="truncate-end">{`  ${line}`}</Text>
      ))}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="cancel" label="Abbrechen" hotkey="n" variant="primary" autoFocus onPress={() => decide($, 'cancel')} />
        <Button key="proceed" label="Trotzdem ausführen" hotkey="j" onPress={() => decide($, 'proceed')} />
      </Box>
    </Box>
  )
}
