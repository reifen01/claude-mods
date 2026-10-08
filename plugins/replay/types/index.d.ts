/** One file edit of a turn, as a unified diff. */
export type Step = {
  /** The file's path as the tool was given it. */
  file: string
  tool: 'Edit' | 'Write' | 'NotebookEdit'
  /** `create` for a new file, `update` otherwise. */
  kind: 'create' | 'update'
  /** Unified diff hunks (`@@ … @@` then ` `, `+`, `-` lines); empty when the engine had none. */
  diff: string
  added: number
  removed: number
}

/** The edits of the last finished main-thread turn, and where the person is in them. */
export type Replay = { steps: Step[]; index: number }

declare module 'claude-code' {
  interface PluginState {
    replay: { replay: Replay | null }
  }
}
