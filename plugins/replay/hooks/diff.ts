import type { Step } from '../types'

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** The engine's structured patch as unified diff text, the form `Code format="diff"` draws. */
export function unifiedOf(hunks: readonly Hunk[]): string {
  return hunks
    .map(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n')
}

export function countsOf(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

// a hunk for a cell or a file the engine gave no patch for: the old lines out, the new lines in
export function hunkOf(oldText: string, newText: string): Hunk[] {
  const o = oldText === '' ? [] : oldText.split('\n')
  const n = newText === '' ? [] : newText.split('\n')
  // trim the common head and tail so the hunk shows what changed, not the whole text
  let head = 0
  while (head < o.length && head < n.length && o[head] === n[head]) head++
  let tail = 0
  while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++
  const lines = [
    ...o.slice(head, o.length - tail).map(l => `-${l}`),
    ...n.slice(head, n.length - tail).map(l => `+${l}`),
  ]
  if (lines.length === 0) return []
  return [{ oldStart: head + 1, oldLines: o.length - head - tail, newStart: head + 1, newLines: n.length - head - tail, lines }]
}

export function stepOf(tool: Step['tool'], file: string, kind: Step['kind'], hunks: readonly Hunk[]): Step {
  const diff = unifiedOf(hunks)
  return { file, tool, kind, diff, ...countsOf(diff) }
}

/** The path shortened to its last three parts, for a title line. */
export function shortOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join('/')}`
}
