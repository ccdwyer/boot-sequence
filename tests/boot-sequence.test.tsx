import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { heightOf, logoCells, tally } from '../hooks/register'

const BAND = {
  plugin: 'boot-sequence',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const missing = () => ({ value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } })

const LSOF = [
  'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node    111 chris   23u  IPv4 0x1      0t0  TCP *:8081 (LISTEN)',
  'node    222 chris   23u  IPv6 0x2      0t0  TCP [::1]:5173 (LISTEN)',
  'postgres 333 chris  7u  IPv4 0x3      0t0  TCP 127.0.0.1:5432 (LISTEN)',
].join('\n')

type Opts = { cwdFails?: boolean; pythonMissing?: boolean; behind?: number; statusFails?: boolean; lsofFails?: boolean; slow?: string; notRepo?: boolean; diskFull?: boolean; dropPrompts?: boolean }

function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  const seen: string[][] = []
  on('prompt.submit', (_$, e) => (opts.dropPrompts ? { drop: 'refused by a test hook' } : { text: e.text }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => {
    if (opts.cwdFails) throw new Error('no cwd')
    return { value: '/work/app' }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 120000, window: 200000, percent: 60 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [
    { name: 'boot', description: '', source: 'plugin', plugin: 'boot-sequence' },
    { name: 'unstick', description: '', source: 'plugin', plugin: 'loop-breaker' },
    { name: 'help', description: '', source: 'builtin' },
  ] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    const argv = e.argv
    seen.push([...argv])
    // The mod runs git with --no-optional-locks; match on the command without it.
    const cmd = argv.filter(a => a !== '--no-optional-locks').join(' ')
    if (opts.slow !== undefined && cmd.startsWith(opts.slow)) {
      await clock.advance(1500)
      throw new Error('timed out')
    }
    if (cmd === 'uname -sm') return ok('Darwin arm64')
    if (cmd === 'sysctl -n hw.ncpu') return ok('12')
    if (cmd === 'sysctl -n hw.memsize') return ok(String(32 * 1024 * 1024 * 1024))
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return opts.notRepo ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', isStdoutTruncated: false, isStderrTruncated: false } } : ok('main')
    if (cmd === 'git status --porcelain') return opts.statusFails ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: index locked', isStdoutTruncated: false, isStderrTruncated: false } } : ok(' M a.ts\n?? b.ts\n')
    if (cmd.startsWith('git rev-list')) return ok(`${opts.behind ?? 0}\t2`)
    if (cmd === 'node --version') return ok('v22.4.0')
    if (cmd === 'python3 --version') return opts.pythonMissing ? missing() : ok('Python 3.12.1')
    if (cmd === 'xcodebuild -version') return ok('Xcode 17.0\nBuild version 17A1')
    if (cmd === 'java -version') return { value: { exitCode: 0, stdout: '', stderr: 'openjdk version "21.0.2"', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd.startsWith('xcrun simctl')) return ok(JSON.stringify({ devices: { 'iOS-26': [{ udid: 'a' }, { udid: 'b' }] } }))
    if (cmd === 'adb devices') return ok('List of devices attached\nemulator-5554\tdevice\n')
    if (cmd.startsWith('lsof')) return opts.lsofFails ? { value: { exitCode: 1, stdout: '', stderr: 'lsof: WARNING: can\'t stat() nfs file system', isStdoutTruncated: false, isStderrTruncated: false } } : ok(LSOF)
    if (cmd.startsWith('df -Pk')) return ok(opts.diskFull ? 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk3 1948455240 1844603712 64389760 97% /' : 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk3 1000000000 500000000 52428800 50% /')
    return missing()
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine below') as RenderElement
  })
  return { clock, seen }
}

async function boot($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as Parameters<typeof $.session.start>[0])
  // The boot waits for the prompt, then each check runs; let the clock run well past the deadline.
  for (let i = 0; i < 200; i += 1) await clock.advance(100)
}

const SLOW = { options: { collapseSeconds: 600 } }

test('the boot runs real checks and types them out with verdicts, composed over the band beneath', SLOW, async ($, on) => {
  const { clock } = world(on)
  await boot($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /POWER-ON SELF TEST/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main · 2 changed · ↑2 ↓0/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /node 22\.4\.0 · python 3\.12\.1 · xcode 17\.0 · java 21\.0\.2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 iOS sims · 1 android/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /:5173 node · :8081 node/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 plugins · 2 plugin commands/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60% of 200k used/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50\.0 GB free/ })).toBeDefined()
    // Context at 60% is a warning; everything else is fine.
    expect(await ui.find({ type: 'Text', text: '[ WARN ]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine below' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'logo' })).toBeDefined()
  await ui.unmount()
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  await desk.unmount()
})

test('a missing tool is skipped silently and a branch behind upstream warns', SLOW, async ($, on) => {
  const { clock } = world(on, { pythonMissing: true, behind: 3 })
  await boot($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /python/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↓3/ })).toBeDefined()
  await ui.unmount()
})

test('a prompt from the person folds the log into one summary line, and x hides it', async ($, on) => {
  const { clock } = world(on)
  await boot($, clock)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▣ BOOT WARN {2}7 ok · 1 warn · 0 fail/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /POWER-ON/ })).toBeUndefined()
  await ui.press({ key: 'hide' })
  await ui.unmount()
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /BOOT/ })).toBeUndefined()
  expect(await again.find({ type: 'Text', text: 'engine below' })).toBeDefined()
  await again.unmount()
})

test('a non-interactive session never boots', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/work/app', surface: null, isInteractive: false } as Parameters<typeof $.session.start>[0])
  await clock.advance(5000)
  expect(seen.length).toBe(0)
})

test('the logo is a full grid of valid cells at every tick', () => {
  for (const at of [0, 3, 10, 25, 200]) {
    const cells = logoCells(at)
    // 3 u32 words per cell, base64 of 12 bytes per cell.
    expect(cells.length % 4).toBe(0)
    expect(cells.length).toBeGreaterThan(100)
  }
  expect(tally([{ id: 'a', label: 'A', status: 'ok', detail: '' }, { id: 'b', label: 'B', status: 'fail', detail: '' }])).toEqual({ run: 0, ok: 1, warn: 0, fail: 1, skip: 0 })
})

test('animated, the log types out over time; with animation off it is all there at once', SLOW, async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as Parameters<typeof $.session.start>[0])
  for (let i = 0; i < 12; i += 1) await clock.advance(100)
  const early = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Checks have finished, but the typewriter has not reached the last line yet.
  expect(await early.find({ type: 'Text', text: /GB free/ })).toBeUndefined()
  await early.unmount()
})

test('with animation off the finished log shows at once', { options: { animate: false, collapseSeconds: 600 } }, async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as Parameters<typeof $.session.start>[0])
  for (let i = 0; i < 12; i += 1) await clock.advance(100)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /GB free/ })).toBeDefined()
  await ui.unmount()
})

test('/boot replays the checks in a pane and the band only shows the summary', SLOW, async ($, on) => {
  const { clock } = world(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const answer = await $.command.run({ command: 'boot', args: '' } as Parameters<typeof $.command.run>[0])
  expect(String(answer.text)).toMatch(/replaying/)
  for (let i = 0; i < 200; i += 1) await clock.advance(100)
  const pane = await $.ui.mount({ plugin: 'boot-sequence', surface: 'terminal', component: 'Pane', requestId: 'boot-sequence', props: { bodyColumns: 100 } } as Parameters<typeof $.ui.mount>[0])
  expect(await pane.find({ type: 'Text', text: /READY\./ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /POWER-ON/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /▣ BOOT/ })).toBeDefined()
  await band.unmount()
})

test('a failed git status is never reported as clean, and an unreadable lsof is skipped, not "no servers"', SLOW, async ($, on) => {
  const { clock } = world(on, { statusFails: true, lsofFails: true })
  await boot($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /main · status unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /clean/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /no dev servers/ })).toBeUndefined()
  await ui.unmount()
})

test('outside a repository git says so', SLOW, async ($, on) => {
  const { clock } = world(on, { notRepo: true })
  await boot($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
  await ui.unmount()
})

test('a command that hangs is cut off by the deadline and the rest are marked skipped, not OK', SLOW, async ($, on) => {
  const { clock } = world(on, { slow: 'git' })
  await boot($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // context and disk ran before git hung; the summary admits what was skipped.
  expect(await ui.find({ type: 'Text', text: /GB free/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '[ SKIP ]' })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  const folded = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await folded.find({ type: 'Text', text: /skipped/ })).toBeDefined()
  expect(await folded.find({ type: 'Text', text: /BOOT OK/ })).toBeUndefined()
  await folded.unmount()
})

test('a short band keeps the other mods on screen by folding to the summary', SLOW, async ($, on) => {
  const { clock } = world(on)
  await boot($, clock)
  const short = { ...BAND, props: { ...BAND.props, maxRows: 4, scroll: { offset: 0, bodyRows: 3 } } }
  const ui = await $.ui.mount({ ...short, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▣ BOOT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine below' })).toBeDefined()
  await ui.unmount()
})

test('a prompt before the boot starts keeps it folded, and an early /boot is not replaced', SLOW, async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as Parameters<typeof $.session.start>[0])
  await $.prompt.submit({ text: 'quick', wait: false, origin: { kind: 'composer' } })
  for (let i = 0; i < 200; i += 1) await clock.advance(100)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /POWER-ON/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▣ BOOT/ })).toBeDefined()
  await ui.unmount()
})

test('a /boot before the startup timer keeps the pane run', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as Parameters<typeof $.session.start>[0])
  await $.command.run({ command: 'boot', args: '' } as Parameters<typeof $.command.run>[0])
  for (let i = 0; i < 200; i += 1) await clock.advance(100)
  // One boot's worth of lsof, not two.
  expect(seen.filter(a => a[0] === 'lsof').length).toBe(1)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /POWER-ON/ })).toBeUndefined()
  await band.unmount()
})

test('a failure partway through still finishes and folds the boot', SLOW, async ($, on) => {
  const { clock } = world(on, { cwdFails: true })
  await boot($, clock)
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▣ BOOT/ })).toBeDefined()
  await ui.unmount()
})

test('heightOf counts a Raster by its rows and a column by its sum', () => {
  const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Raster', props: { rows: 5 } }, { type: 'Text', children: ['a\nb'] }, { type: 'Box', children: [{ type: 'Text', children: ['x'] }, { type: 'Text', children: ['y'] }] }] }
  expect(heightOf(tree)).toBe(8)
})

test('a boot that crashes before any check is FAIL, never "BOOT OK"', SLOW, async ($, on) => {
  const { clock } = world(on, { cwdFails: true })
  await boot($, clock)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▣ BOOT FAIL/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /BOOT OK/ })).toBeUndefined()
  await ui.unmount()
})

test('a medium band keeps the failing checks on screen, not just the last ones', SLOW, async ($, on) => {
  const { clock } = world(on, { diskFull: true })
  await boot($, clock)
  const medium = { ...BAND, props: { ...BAND.props, maxRows: 12, scroll: { offset: 0, bodyRows: 12 } } }
  const ui = await $.ui.mount({ ...medium, surface: 'terminal' })
  // Context (60%) warns and disk (97% used) fails; both stay visible even though the band is short.
  expect(await ui.find({ type: 'Text', text: /60% of 200k used/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /97% used/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '[ FAIL ]' })).toBeDefined()
  await ui.unmount()
})

test('a refused prompt does not fold the boot', SLOW, async ($, on) => {
  const { clock } = world(on, { dropPrompts: true })
  await boot($, clock)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /POWER-ON SELF TEST/ })).toBeDefined()
  await ui.unmount()
})

test('an ahead/behind query that times out is "unavailable", never "no upstream" and OK', SLOW, async ($, on) => {
  const { clock } = world(on, { slow: 'git rev-list' })
  await boot($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ahead\/behind unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no upstream/ })).toBeUndefined()
  await ui.unmount()
})
