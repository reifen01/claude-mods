import type { Report, Risk } from '../types'
import { wordsOf } from './classify'

const SHOWN = 6

// German grouping: 12345 → "12.345"
export const countOf = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

// du's kilobytes → "2,3 GB"
export function sizeOf(kb: number): string {
  const [value, unit] = kb >= 1024 ** 2 ? [kb / 1024 ** 2, 'GB'] : kb >= 1024 ? [kb / 1024, 'MB'] : [kb, 'KB']
  return `${value.toFixed(unit === 'KB' ? 0 : 1).replace(/\.0$/, '').replace('.', ',')} ${unit}`
}

const linesOf = (text: string) => text.split('\n').filter(l => l.trim() !== '')

// paths whose loss is the whole machine, the home folder or the whole project
const CRITICAL = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '.', './', './*', '*', '..', '../'])

/** Runs a read-only command, resolving its stdout, or null when it failed or could not run. */
export type Run = (argv: string[]) => Promise<string | null>

/** Measures what `risk` would destroy in `cwd`, through `run`, which only reads. */
export async function measure(run: Run, risk: Risk, cwd: string): Promise<Report> {
  switch (risk.kind) {
    case 'rm':
      return measureRm(run, risk, cwd)
    case 'git-reset-hard':
      return measureReset(run, risk)
    case 'git-clean':
      return measureClean(run, risk)
    case 'git-discard':
      return measureDiscard(run, risk)
    case 'git-push-force':
      return measurePush(run)
    case 'git-branch-delete':
      return measureBranch(run, risk)
    case 'find-delete':
      return measureFind(run, risk)
  }
}

async function measureRm(run: Run, risk: Risk, cwd: string): Promise<Report> {
  const isCritical = risk.args.some(t => CRITICAL.has(t) || t === cwd || t === `${cwd}/`)
  let files = 0
  let kb = 0
  const lines: string[] = []
  for (const target of risk.args) {
    // a pattern or a variable expands only in the shell; it is named, not measured
    if (/[*?[\]{}$`~]/.test(target)) {
      lines.push(`${target}: Muster, nicht ausgewertet`)
      continue
    }
    const du = await run(['du', '-sk', '--', target])
    if (du === null) {
      lines.push(`${target}: existiert nicht`)
      continue
    }
    const size = Number(du.split(/\s/)[0]) || 0
    const count = linesOf((await run(['find', target])) ?? '').length
    files += count
    kb += size
    lines.push(`${target}: ${countOf(count)} Einträge, ${sizeOf(size)}`)
  }
  return {
    summary: `würde ${countOf(files)} Dateien und Ordner (${sizeOf(kb)}) unwiderruflich löschen`,
    lines: lines.slice(0, SHOWN),
    severity: isCritical ? 'critical' : 'high',
  }
}

async function measureReset(run: Run, risk: Risk): Promise<Report> {
  const changed = linesOf((await run(['git', 'status', '--porcelain'])) ?? '').filter(l => !l.startsWith('??'))
  const ref = risk.args[0]
  const dropped = ref ? linesOf((await run(['git', 'log', '--oneline', `${ref}..HEAD`])) ?? '') : []
  const parts = [`ungespeicherte Änderungen in ${countOf(changed.length)} Dateien verwerfen`]
  if (dropped.length > 0) parts.push(`${countOf(dropped.length)} Commits vom Branch entfernen`)
  return {
    summary: `würde ${parts.join(' und ')}`,
    lines: [...changed.map(l => l.slice(3)), ...dropped.map(c => `Commit ${c}`)].slice(0, SHOWN),
    severity: changed.length + dropped.length > 0 ? 'critical' : 'high',
  }
}

async function measureClean(run: Run, risk: Risk): Promise<Report> {
  // the same flags as a dry run: -fdx becomes -n -dx
  const kept = risk.args.map(f => (f.startsWith('--') ? '' : f.replace(/[^dxX]/g, ''))).join('')
  const removed = linesOf((await run(['git', 'clean', '-n', ...(kept ? [`-${kept}`] : [])])) ?? '').map(l =>
    l.replace(/^Would remove /, ''),
  )
  return {
    summary: `würde ${countOf(removed.length)} ungetrackte Dateien und Ordner löschen`,
    lines: removed.slice(0, SHOWN),
    severity: 'high',
  }
}

async function measureDiscard(run: Run, risk: Risk): Promise<Report> {
  const paths = risk.args.length > 0 ? risk.args : ['.']
  const files = linesOf((await run(['git', 'diff', '--name-only', '--', ...paths])) ?? '')
  const stat = linesOf((await run(['git', 'diff', '--shortstat', '--', ...paths])) ?? '')[0]?.trim()
  return {
    summary: `würde ungespeicherte Änderungen in ${countOf(files.length)} Dateien verwerfen`,
    lines: [...(stat ? [stat] : []), ...files].slice(0, SHOWN),
    severity: files.length > 0 ? 'critical' : 'high',
  }
}

async function measurePush(run: Run): Promise<Report> {
  const upstream = (await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim()
  if (!upstream) {
    return { summary: 'würde einen Remote-Branch überschreiben (kein Upstream bekannt)', lines: [], severity: 'high' }
  }
  const lost = linesOf((await run(['git', 'log', '--oneline', 'HEAD..@{u}'])) ?? '')
  return {
    summary:
      lost.length > 0
        ? `würde ${countOf(lost.length)} Commits auf ${upstream} überschreiben (Stand letzter fetch)`
        : `überschreibt ${upstream}; laut letztem fetch geht kein Commit verloren`,
    lines: lost.slice(0, SHOWN).map(c => `Commit ${c}`),
    severity: lost.length > 0 ? 'critical' : 'high',
  }
}

async function measureBranch(run: Run, risk: Risk): Promise<Report> {
  const lines: string[] = []
  let total = 0
  for (const name of risk.args) {
    const only = linesOf((await run(['git', 'log', '--oneline', name, '--not', 'HEAD', '--remotes'])) ?? '')
    total += only.length
    lines.push(`${name}: ${countOf(only.length)} Commits, die sonst nirgends liegen`)
  }
  return {
    summary: `würde ${risk.args.length === 1 ? 'einen Branch' : `${risk.args.length} Branches`} löschen, mit ${countOf(total)} Commits nur dort`,
    lines: lines.slice(0, SHOWN),
    severity: total > 0 ? 'critical' : 'high',
  }
}

async function measureFind(run: Run, risk: Risk): Promise<Report> {
  const all = wordsOf(risk.segment)
  const words = all.slice(Math.max(0, all.indexOf('find')))
  // only a plain find is re-run as a dry run: one that runs other programs or reads the shell is named, not run
  const isPlain = !words.some(w => /^-(exec|execdir|ok|okdir|fprint|fls|fprintf)$/.test(w) || /[$`<>]/.test(w))
  if (!isPlain) {
    return { summary: 'würde Dateien löschen (find mit -exec, nicht ausgewertet)', lines: [], severity: 'high' }
  }
  const found = linesOf((await run(words.map(w => (w === '-delete' ? '-print' : w)))) ?? '')
  return {
    summary: `würde ${countOf(found.length)} Dateien und Ordner löschen`,
    lines: found.slice(0, SHOWN),
    severity: 'high',
  }
}
