import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage } from 'claude-code'

import type { Forecast } from '../types'

const forecast = atom({ plugin: 'token-weather', key: 'forecast' } as const, null)

const TURNS = 12
const BLOCKS = '▁▂▃▄▅▆▇█'

type Weather = { icon: string; word: string; color: string }

export function weatherOf(percent: number): Weather {
  if (percent < 25) return { icon: '☀', word: 'Heiter', color: 'yellow' }
  if (percent < 50) return { icon: '☁', word: 'Bewölkt', color: 'cyan' }
  if (percent < 75) return { icon: '☂', word: 'Regenschauer', color: 'blue' }
  if (percent < 90) return { icon: '☇', word: 'Gewitter', color: 'magenta' }
  return { icon: '↯', word: 'Bald komprimieren', color: 'red' }
}

// German style: 134400 → "134,4k", 200000 → "200k", 1000000 → "1M"
export function tokensOf(n: number): string {
  const abs = Math.abs(n)
  const [value, unit] = abs >= 1_000_000 ? [n / 1_000_000, 'M'] : abs >= 1000 ? [n / 1000, 'k'] : [n, '']
  return `${value.toFixed(unit ? 1 : 0).replace(/\.0$/, '').replace('.', ',')}${unit}`
}

// each bar is that turn's fill of the whole window, so a full row of █ is a full window
export function sparklineOf(history: number[], window: number): string {
  return history
    .map(t => BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, Math.floor((t / window) * BLOCKS.length)))])
    .join('')
}

export function deltaOf(delta: number): string {
  if (delta > 0) return `▲ +${tokensOf(delta)} letzte Runde`
  if (delta < 0) return `▼ −${tokensOf(-delta)} letzte Runde`
  return '= ±0 letzte Runde'
}

function percentOf(f: Forecast, tokens: number): number {
  return Math.min(100, Math.round((tokens / f.window) * 100))
}

// one reading per turn: the input side of the turn's last response against the window
function record(prev: Forecast | null, context: SessionContextUsage): Forecast | null {
  const tokens = context.tokens
  if (tokens === undefined || !context.window) return prev
  const last = prev?.history.at(-1)
  return {
    history: [...(prev?.history ?? []), tokens].slice(-TURNS),
    window: context.window,
    delta: last === undefined ? null : tokens - last,
  }
}

export const register: Register = on => {
  // a resumed session already has a fill: start the chart from it
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, forecast)) === null) {
      const { context } = await $.session.usage()
      await update($, forecast, f => record(f, context))
    }
    return result
  })

  // the engine measures after each main-thread turn; `context` in `changed` means the fill moved
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, forecast, f => record(f, e.context))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, forecast)
    const tokens = f?.history.at(-1)
    if (!f || tokens === undefined || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const percent = percentOf(f, tokens)
    const w = weatherOf(percent)

    const line = (
      <Box key="token-weather" flexDirection="row" gap={2} width={e.props.bodyColumns}>
        <Text color={w.color} bold wrap="truncate">{`${w.icon} ${w.word}`}</Text>
        <Text wrap="truncate">
          {`${percent}% · ${tokensOf(tokens)} / ${tokensOf(f.window)}`}
        </Text>
        <Text color={w.color} wrap="truncate">{sparklineOf(f.history, f.window)}</Text>
        {f.delta === null ? null : (
          <Text dimColor wrap="truncate">{deltaOf(f.delta)}</Text>
        )}
      </Box>
    )

    // what the host and other plugins draw here (plan-progress's bars) stays, above this line
    const below = await next(e)
    return below ? (
      <Box flexDirection="column">
        {below}
        {line}
      </Box>
    ) : (
      line
    )
  })
}
