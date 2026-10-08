import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionContextUsage } from 'claude-code'

import { deltaOf, sparklineOf, tokensOf, weatherOf } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 1 }, view: {} },
} as const

// the engine's own ends of the two events: an empty band, and the echo of what moved
const engine = (on: On) => {
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, null))
  on('session.measure', ($, e) => ({ changed: e.changed }))
}

// the four parts of the line, in order: sky, fill, chart, delta
const parts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

const measure = (context: SessionContextUsage) => ({ context, rateLimits: [], changed: ['context' as const] })

describe('helpers', () => {
  test('weather follows the thresholds', async () => {
    expect(weatherOf(0).word).toBe('Heiter (clear)')
    expect(weatherOf(24).word).toBe('Heiter (clear)')
    expect(weatherOf(25).word).toBe('Bewölkt (cloudy)')
    expect(weatherOf(49).word).toBe('Bewölkt (cloudy)')
    expect(weatherOf(50).word).toBe('Regenschauer (showers)')
    expect(weatherOf(75).word).toBe('Gewitter (storm)')
    expect(weatherOf(89).word).toBe('Gewitter (storm)')
    expect(weatherOf(90)).toEqual({ icon: '↯', word: 'Bald komprimieren (compact soon)', color: 'red' })
  })

  test('token counts read like 134,4k / 200k', async () => {
    expect(tokensOf(134_400)).toBe('134,4k')
    expect(tokensOf(200_000)).toBe('200k')
    expect(tokensOf(1_000_000)).toBe('1M')
    expect(tokensOf(512)).toBe('512')
    expect(deltaOf(98_300)).toBe('▲ +98,3k letzte Runde (last turn)')
    expect(deltaOf(-40_000)).toBe('▼ −40k letzte Runde (last turn)')
  })

  test('the chart scales each turn against the whole window', async () => {
    expect(sparklineOf([0, 100_000, 200_000], 200_000)).toBe('▁▅█')
  })
})

test('the band shows nothing before the first reading, then the forecast after each turn', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'token-weather', surface, ...BAND })
    if (surface === 'terminal') {
      expect(await ui.find({ text: /Heiter|Bewölkt/ })).toBeUndefined()
      await $.session.measure(measure({ tokens: 36_100, window: 200_000, percent: 18 }))
      await $.session.measure(measure({ tokens: 134_400, window: 200_000, percent: 67 }))
    }
    expect(await parts(ui)).toEqual(['☂ Regenschauer (showers)', '67% · 134,4k / 200k', '▂▆', '▲ +98,3k letzte Runde (last turn)'])
    await ui.unmount()
  }
})

test('the chart keeps the last 12 turns', async ($, on) => {
  engine(on)
  for (let i = 1; i <= 15; i++) {
    await $.session.measure(measure({ tokens: i * 10_000, window: 200_000 }))
  }
  const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', ...BAND })
  const [sky, fill, chart] = await parts(ui)
  expect(sky).toBe('☇ Gewitter (storm)')
  expect(fill).toBe('75% · 150k / 200k')
  expect([...(chart ?? '')]).toHaveLength(12)
})

test('a compaction shows as a drop and clears the sky', async ($, on) => {
  engine(on)
  await $.session.measure(measure({ tokens: 185_000, window: 200_000 }))
  const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', ...BAND })
  expect((await parts(ui))[0]).toBe('↯ Bald komprimieren (compact soon)')
  await $.session.measure(measure({ tokens: 30_000, window: 200_000 }))
  const [sky, , , delta] = await parts(ui)
  expect(sky).toBe('☀ Heiter (clear)')
  expect(delta).toBe('▼ −155k letzte Runde (last turn)')
})
