export type Forecast = {
  /** Input tokens the context held after each of the last turns, oldest first (at most 12). */
  history: number[]
  /** The model's context window, in tokens. */
  window: number
  /** What the last turn added (negative after a compaction); null before the second reading. */
  delta: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-weather': { forecast: Forecast | null }
  }
}
