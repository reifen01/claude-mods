import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Replay, Step } from '../types'
import { hunkOf, shortOf, stepOf } from './diff'
import type { Hunk } from './diff'

const PANE = 'replay'
const replay = atom({ plugin: 'replay', key: 'replay' } as const, null)

// the edits of the turn under way; one list per main-thread turn, a subagent's edits counted with it
let pending: Step[] = []

type Patched = { structuredPatch?: readonly Hunk[] }

const move = ($: EngineInterface, by: number) =>
  update($, replay, r => (r ? { ...r, index: Math.max(0, Math.min(r.steps.length - 1, r.index + by)) } : r))

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const ran = await next(e) // the edit runs untouched
    if (ran.deny !== undefined || ran.isError) return ran
    const r = ran.result as Patched | undefined
    if (e.tool === 'Edit' && r?.structuredPatch) {
      pending.push(stepOf('Edit', e.file_path, 'update', r.structuredPatch))
    } else if (e.tool === 'Write') {
      const w = ran.result as (Patched & { type?: 'create' | 'update'; originalFile?: string | null }) | undefined
      const hunks = w?.structuredPatch?.length ? w.structuredPatch : hunkOf(w?.originalFile ?? '', e.content)
      pending.push(stepOf('Write', e.file_path, w?.type ?? 'update', hunks))
    } else if (e.tool === 'NotebookEdit') {
      const n = ran.result as { old_source?: string; new_source?: string } | undefined
      const cell = e.cell_id ? `${e.notebook_path} · Zelle ${e.cell_id}` : e.notebook_path
      pending.push(stepOf('NotebookEdit', cell, 'update', hunkOf(n?.old_source ?? '', e.edit_mode === 'delete' ? '' : (n?.new_source ?? e.new_source))))
    }
    return ran
  })

  // a turn begins (main thread: a subagent's loop has no turn.start of its own): the list starts over
  on('turn.start', ($, e, next) => {
    pending = []
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && pending.length > 0) {
      await update($, replay, () => ({ steps: pending, index: 0 })) // one replay per turn
      pending = []
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'replay', description: 'Die Dateiänderungen der letzten Runde Schritt für Schritt ansehen (step through the last turn\'s file edits)' })
    return r
  })

  on('command.run', { command: 'replay' }, async $ => {
    const r = await read($, replay)
    if (!r || r.steps.length === 0) return { text: 'Keine Dateiänderungen in der letzten Runde (no edits in the last turn).' }
    await update($, replay, cur => (cur ? { ...cur, index: 0 } : cur))
    const opened = await $.ui.open({ id: PANE, title: 'Wiedergabe (Replay)', focus: true, closeOnEscape: true })
    const n = r.steps.length
    return {
      text: opened.isPlaced
        ? `Wiedergabe (replay): ${n} ${n === 1 ? 'Änderung' : 'Änderungen'} der letzten Runde.`
        : `Wiedergabe (replay): ${n} ${n === 1 ? 'Änderung' : 'Änderungen'}; das Fenster ist zu schmal für ein Pane (too narrow: ${opened.reason}).`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'Wiedergabe konnte nicht geöffnet werden (replay could not open).' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const r = await read($, replay)
    const { Text } = $.ui.resolve(e)
    return r && r.steps.length > 0 ? card($, e, r) : <Text dimColor>Keine Dateiänderungen in der letzten Runde (no edits in the last turn).</Text>
  })
}

function card($: EngineInterface, e: RenderInput, r: Replay) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const i = r.index
  const step = r.steps[i]
  if (!step) return <Text dimColor>Keine Dateiänderungen in der letzten Runde (no edits in the last turn).</Text>
  const n = r.steps.length
  const kind = step.kind === 'create' ? 'neu (new)' : step.tool === 'NotebookEdit' ? 'Notebook' : 'geändert (changed)'
  return (
    <Box key="replay" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{`Schritt (step) ${i + 1}/${n}`}</Text>
        <Text color="cyan" wrap="truncate-start">{shortOf(step.file)}</Text>
        <Text dimColor>{`(${kind})`}</Text>
        <Text color="green">{`+${step.added}`}</Text>
        <Text color="red">{`−${step.removed}`}</Text>
      </Box>
      {step.diff ? (
        <Code source={step.diff} format="diff" path={step.file} wrap="truncate-end" />
      ) : (
        <Text dimColor>Kein Diff verfügbar, die Engine hat keinen Patch geliefert (no diff available).</Text>
      )}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="prev" label="◀ Zurück (back)" hotkey="z" dimColor={i === 0} onPress={() => move($, -1)} />
        <Button key="next" label="Weiter (next) ▶" hotkey="w" variant="primary" autoFocus dimColor={i === n - 1} onPress={() => move($, 1)} />
        <Button key="close" label="Schließen (close)" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    </Box>
  )
}
