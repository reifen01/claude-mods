export type RiskKind =
  | 'rm'
  | 'git-reset-hard'
  | 'git-clean'
  | 'git-discard'
  | 'git-push-force'
  | 'git-branch-delete'
  | 'find-delete'

/** A command segment that would destroy something, and what it names. */
export type Risk = { kind: RiskKind; label: string; segment: string; args: string[] }

/** What the command would do, measured before it runs. */
export type Report = {
  /** One line: "würde 1.234 Dateien (2,3 GB) löschen". */
  summary: string
  /** Up to a few lines of detail: file names, commits, sizes. */
  lines: string[]
  /** `critical` for targets like /, ~ or the whole working tree. */
  severity: 'critical' | 'high'
}

/** The command waiting for the person's answer. */
export type Held = {
  id: string
  command: string
  risk: Risk
  report: Report
  where: 'pane' | 'band'
  decision: 'proceed' | 'cancel' | null
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { held: Held | null }
  }
}
