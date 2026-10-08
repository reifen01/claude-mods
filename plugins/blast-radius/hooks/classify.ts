import type { Risk } from '../types'

// a shell word list good enough to read a command, never to run one: quotes are stripped, nothing expands
export function wordsOf(segment: string): string[] {
  return (segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(w => w.replace(/^(['"])(.*)\1$/, '$2'))
}

const isFlag = (w: string) => w.startsWith('-') && w !== '-'

// `sudo`, `env X=1`, `X=1` and `command` in front change nothing about what the command destroys
function stripPrefix(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (w === 'sudo' || w === 'env' || w === 'command' || w === 'nohup' || w === 'time') i++
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else break
  }
  return words.slice(i)
}

function classifySegment(segment: string): Risk | null {
  const words = stripPrefix(wordsOf(segment))
  const [cmd, ...rest] = words

  if (cmd === 'rm' || cmd?.endsWith('/rm')) {
    const ddash = rest.indexOf('--')
    const flags = (ddash < 0 ? rest : rest.slice(0, ddash)).filter(isFlag)
    const isRecursive = flags.some(f => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f))
    if (!isRecursive) return null
    const args = ddash < 0 ? rest.filter(w => !isFlag(w)) : [...rest.slice(0, ddash).filter(w => !isFlag(w)), ...rest.slice(ddash + 1)]
    return { kind: 'rm', label: 'Rekursives Löschen (recursive delete)', segment, args }
  }

  if (cmd === 'find' && rest.includes('-delete')) {
    return { kind: 'find-delete', label: 'find -delete', segment, args: rest }
  }

  if (cmd === 'git') {
    // skip git's own options (-C <dir>, -c <k=v>) to reach the subcommand
    let i = 0
    while (i < rest.length && isFlag(rest[i] ?? '')) i += rest[i] === '-C' || rest[i] === '-c' ? 2 : 1
    const sub = rest[i]
    const tail = rest.slice(i + 1)
    const operands = tail.filter(w => !isFlag(w))

    if (sub === 'reset' && tail.includes('--hard')) {
      return { kind: 'git-reset-hard', label: 'git reset --hard', segment, args: operands }
    }
    if (sub === 'clean' && tail.some(f => f === '--force' || /^-[a-zA-Z]*f/.test(f))) {
      return { kind: 'git-clean', label: 'git clean', segment, args: tail.filter(isFlag) }
    }
    if (sub === 'checkout' && (tail.includes('--') || operands.includes('.'))) {
      const ddash = tail.indexOf('--')
      const paths = ddash < 0 ? operands : tail.slice(ddash + 1)
      return { kind: 'git-discard', label: 'Änderungen verwerfen (discard changes)', segment, args: paths }
    }
    if (sub === 'restore' && !tail.includes('--staged') && !tail.includes('-S')) {
      return { kind: 'git-discard', label: 'Änderungen verwerfen (discard changes)', segment, args: operands }
    }
    if (sub === 'push' && tail.some(f => f === '--force' || f.startsWith('--force-with-lease') || /^-[a-zA-Z]*f/.test(f) || /^\+/.test(f))) {
      return { kind: 'git-push-force', label: 'Force-Push (force push)', segment, args: operands }
    }
    if (sub === 'branch' && tail.some(f => f === '-D' || /^-[a-zA-Z]*D/.test(f))) {
      return { kind: 'git-branch-delete', label: 'Branch löschen (delete branch, -D)', segment, args: operands }
    }
  }

  return null
}

/** The first part of `command` that would destroy something, or null when nothing would. */
export function classify(command: string): Risk | null {
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const risk = classifySegment(segment.trim())
    if (risk) return risk
  }
  return null
}
