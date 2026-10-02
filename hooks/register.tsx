import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Boot, Line, Status } from '../types'

const boot = atom({ plugin: 'boot-sequence', key: 'boot' } as const, null)
const tick = atom({ plugin: 'boot-sequence', key: 'tick' } as const, 0)
const isCollapsed = atom({ plugin: 'boot-sequence', key: 'isCollapsed' } as const, false)
const isHidden = atom({ plugin: 'boot-sequence', key: 'isHidden' } as const, false)
// Set by the person's first prompt and never cleared by a boot, so a boot that
// starts after it stays folded.
const hasPrompted = atom({ plugin: 'boot-sequence', key: 'hasPrompted' } as const, false)

const PANE = 'boot-sequence'
const FRAME_MS = 60
// Ticks the logo's scanline takes to sweep down, and characters typed per tick.
const LOGO_TICKS = 10
const CHARS_PER_TICK = 6
// Each command gets at most this long, and never past the whole boot's deadline.
const CHECK_MS = 1500
const DEADLINE_MS = 5000
// The person's own prompts; a channel relay can be someone else's message.
const PERSON = ['composer', 'bridge', 'slack-ping']
// The checks that can fail come first, so a slow machine still shows them.
const IDS = ['context', 'disk', 'git', 'ports', 'devices', 'mods', 'cpu', 'toolchain']
const LABELS: Record<string, string> = {
  cpu: 'CPU', git: 'GIT', toolchain: 'TOOLCHAIN', devices: 'DEVICES',
  ports: 'PORTS', mods: 'MODS', context: 'CONTEXT', disk: 'DISK',
}
const COLOR: Record<Status, string> = { run: '#6c7086', ok: '#a6e3a1', warn: '#f9e2af', fail: '#f38ba8', skip: '#6c7086' }
const BADGE: Record<Status, string> = { run: '[ .... ]', ok: '[  OK  ]', warn: '[ WARN ]', fail: '[ FAIL ]', skip: '[ SKIP ]' }
const DEV_PORTS = new Set([3000, 3001, 4200, 5173, 5174, 8000, 8080, 8081, 8888, 19000, 19001, 19006])

// Timers live in the module: a reload drops them, and the state below survives.
let stopTicker: (() => void) | null = null
let runSeq = 0
// Bumped whenever a ticker starts or stops, so a ticker armed after a newer one cancels itself.
let tickerGen = 0
// The band boot whose collapse is armed, so it is armed once, when its log has been typed out.
let collapseArmedFor = 0

type Result = { status: Status; detail: string } | null
type Options = { animate?: boolean; collapseSeconds?: number }
type Proc = { code: number; out: string; err: string; truncated: boolean }
/** One boot's time budget, and whether a newer boot has taken over. */
type Budget = { seq: number; deadline: number; timedOut: boolean }

// ---------------------------------------------------------------- the logo

// A 4x5 block font for the letters the logo needs.
const FONT: Record<string, string[]> = {
  C: ['.###', '#...', '#...', '#...', '.###'],
  L: ['#...', '#...', '#...', '#...', '####'],
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'],
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
  ' ': ['..', '..', '..', '..', '..'],
}
const WORD = 'CLAUDE CODE'
const LOGO_ROWS = 5
const LOGO_COLS = [...WORD].reduce((n, ch) => n + (FONT[ch]?.[0]?.length ?? 0) + 1, 0) - 1

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The logo's cells at a tick: a gradient wordmark revealed by a scanline, then a sheen that sweeps across. */
export function logoCells(at: number): string {
  const words = new Uint32Array(LOGO_COLS * LOGO_ROWS * 3)
  const revealed = Math.min(LOGO_ROWS, Math.floor((at / LOGO_TICKS) * (LOGO_ROWS + 1)))
  const sheen = at > LOGO_TICKS ? ((at - LOGO_TICKS) * 2) % (LOGO_COLS + 24) - 12 : -99
  let x = 0
  for (const ch of WORD) {
    const glyph = FONT[ch] ?? []
    const width = glyph[0]?.length ?? 0
    for (let gx = 0; gx < width; gx += 1) {
      for (let y = 0; y < LOGO_ROWS; y += 1) {
        const i = (y * LOGO_COLS + x + gx) * 3
        const on = glyph[y]?.[gx] === '#'
        const base = mix(0x89dceb, 0xcba6f7, (x + gx) / LOGO_COLS)
        const lit = Math.abs(x + gx - sheen) < 3
        if (y < revealed && on) {
          words[i] = 0x2588
          words[i + 1] = lit ? 0xffffff : base
        } else if (y === revealed && revealed < LOGO_ROWS) {
          words[i] = 0x2580
          words[i + 1] = 0x94e2d5
        } else {
          words[i] = 0x20
          words[i + 1] = 0x01000000
        }
        words[i + 2] = 0x01000000
      }
    }
    x += width + 1
  }
  for (let i = 0; i < words.length; i += 3) if (words[i] === 0) { words[i] = 0x20; words[i + 1] = 0x01000000; words[i + 2] = 0x01000000 }
  return base64(new Uint8Array(words.buffer))
}

// ---------------------------------------------------------------- the checks

async function isLive($: EngineInterface, budget: Budget): Promise<boolean> {
  if (budget.seq !== runSeq) return false
  return (await $.clock.now()) < budget.deadline
}

/** Runs one command under the boot's budget; null when it could not run or ran out of time. */
async function run($: EngineInterface, budget: Budget, argv: string[], cwd?: string): Promise<Proc | null> {
  if (budget.seq !== runSeq) return null
  const left = budget.deadline - (await $.clock.now())
  if (left < 50) {
    budget.timedOut = true
    return null
  }
  const timeoutMs = Math.min(CHECK_MS, left)
  const startedAt = await $.clock.now()
  try {
    const r = await $.process.run(argv, { timeoutMs, cwd })
    return { code: r.exitCode, out: r.stdout, err: r.stderr, truncated: r.isStdoutTruncated || r.isStderrTruncated }
  } catch {
    // The host kills a child at its timeout and the call rejects: remember that it ran out of time.
    if ((await $.clock.now()) - startedAt >= timeoutMs * 0.9) budget.timedOut = true
    return null
  }
}

function firstVersion(text: string): string | null {
  const m = text.match(/(\d+\.\d+(?:\.\d+)?)/)
  return m ? (m[1] as string) : null
}

async function checkCpu($: EngineInterface, budget: Budget): Promise<Result> {
  const r = await run($, budget, ['uname', '-sm'])
  if (r === null || r.code !== 0) return null
  let cores = await run($, budget, ['sysctl', '-n', 'hw.ncpu'])
  if (cores === null || cores.code !== 0) cores = await run($, budget, ['getconf', '_NPROCESSORS_ONLN'])
  const n = cores !== null && cores.code === 0 && cores.out.trim() !== '' ? ` · ${cores.out.trim()} cores` : ''
  return { status: 'ok', detail: `${r.out.trim().split('\n')[0]}${n}` }
}

async function checkMemory($: EngineInterface, budget: Budget): Promise<number> {
  const r = await run($, budget, ['sysctl', '-n', 'hw.memsize'])
  const bytes = r !== null && r.code === 0 ? Number(r.out.trim()) : NaN
  if (Number.isFinite(bytes) && bytes > 0) return Math.round(bytes / 1048576)
  // Linux has no hw.memsize; /proc/meminfo has the total in kB.
  try {
    const text = await $.fs.read('/proc/meminfo')
    const m = String(text).match(/MemTotal:\s+(\d+)\s*kB/)
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

async function checkGit($: EngineInterface, budget: Budget, cwd: string): Promise<Result> {
  const branch = await run($, budget, ['git', '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  // git missing or out of time: skip the line rather than guess.
  if (branch === null || branch.code === 127) return null
  if (branch.code !== 0) {
    if (/not a git repository/i.test(branch.err)) return { status: 'warn', detail: 'not a git repository' }
    return { status: 'warn', detail: 'git unavailable here' }
  }
  const name = branch.out.trim().split('\n')[0]
  const status = await run($, budget, ['git', '--no-optional-locks', 'status', '--porcelain'], cwd)
  if (status === null || status.code !== 0 || status.truncated) return { status: 'warn', detail: `${name} · status unavailable` }
  const dirty = status.out.split('\n').filter(l => l.trim() !== '').length
  const counts = await run($, budget, ['git', '--no-optional-locks', 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd)
  const changed = dirty === 0 ? 'clean' : `${dirty} changed`
  // Out of time or failed for a reason other than "no upstream": say it is unknown, never "no upstream".
  if (counts === null) return { status: 'warn', detail: `${name} · ${changed} · ahead/behind unavailable` }
  if (counts.code !== 0) {
    if (/no upstream|does not point to a branch|unknown revision/i.test(counts.err)) return { status: 'ok', detail: `${name} · ${changed} · no upstream` }
    return { status: 'warn', detail: `${name} · ${changed} · ahead/behind unavailable` }
  }
  const [b, a] = counts.out.trim().split(/\s+/).map(Number)
  const behind = b ?? 0
  return { status: behind > 0 ? 'warn' : 'ok', detail: `${name} · ${changed} · ↑${a ?? 0} ↓${behind}` }
}

async function checkToolchain($: EngineInterface, budget: Budget): Promise<Result> {
  const found: string[] = []
  const tools: Array<[string, string[], boolean]> = [
    ['node', ['node', '--version'], false],
    ['pnpm', ['pnpm', '--version'], false],
    ['python', ['python3', '--version'], false],
    ['xcode', ['xcodebuild', '-version'], false],
    // java prints its version on stderr.
    ['java', ['java', '-version'], true],
  ]
  for (const [label, argv, onErr] of tools) {
    const r = await run($, budget, argv)
    if (r === null || r.code !== 0) continue
    const v = firstVersion(onErr ? r.err : r.out)
    if (v !== null) found.push(`${label} ${v}`)
  }
  if (found.length === 0) return null
  return { status: 'ok', detail: found.join(' · ') }
}

async function checkDevices($: EngineInterface, budget: Budget): Promise<Result> {
  const parts: string[] = []
  const sims = await run($, budget, ['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'])
  if (sims !== null && sims.code === 0) {
    try {
      const parsed = JSON.parse(sims.out) as { devices?: Record<string, unknown[]> }
      const n = Object.values(parsed.devices ?? {}).reduce((sum, list) => sum + list.length, 0)
      parts.push(`${n} iOS sim${n === 1 ? '' : 's'}`)
    } catch {
      // A partial read: say nothing rather than guess.
    }
  }
  const adb = await run($, budget, ['adb', 'devices'])
  if (adb !== null && adb.code === 0) {
    const n = adb.out.split('\n').filter(l => /\tdevice$/.test(l)).length
    parts.push(`${n} android`)
  }
  if (parts.length === 0) return null
  return { status: 'ok', detail: parts.join(' · ') }
}

async function checkPorts($: EngineInterface, budget: Budget): Promise<Result> {
  const r = await run($, budget, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN'])
  if (r === null || r.truncated) return null
  const table = r.out.split('\n')
  const hasTable = /^COMMAND\s/.test(table[0] ?? '')
  // lsof exits 1 with an empty table when nothing listens; anything else unreadable is skipped.
  if (!hasTable && !(r.code === 1 && r.out.trim() === '' && r.err.trim() === '')) return null
  const seen = new Map<number, string>()
  for (const line of table.slice(1)) {
    const cols = line.trim().split(/\s+/)
    const port = Number(cols[8]?.split(':').pop())
    if (DEV_PORTS.has(port) && !seen.has(port)) seen.set(port, cols[0] ?? '?')
  }
  if (seen.size === 0) return { status: 'ok', detail: 'no dev servers listening' }
  const list = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([p, cmd]) => `:${p} ${cmd}`)
  return { status: 'ok', detail: list.slice(0, 5).join(' · ') }
}

async function checkMods($: EngineInterface): Promise<Result> {
  try {
    const commands = await $.command.list()
    const own = commands.filter(c => c.source === 'plugin')
    const plugins = new Set(own.map(c => c.plugin).filter((p): p is string => typeof p === 'string'))
    return { status: 'ok', detail: `${plugins.size} plugin${plugins.size === 1 ? '' : 's'} · ${own.length} plugin commands` }
  } catch {
    return null
  }
}

async function checkContext($: EngineInterface): Promise<Result> {
  try {
    const usage = await $.session.usage()
    const ctx = usage.context
    const pct = typeof ctx.percent === 'number' ? Math.round(ctx.percent) : ctx.tokens !== undefined ? Math.round((ctx.tokens / ctx.window) * 100) : 0
    const kt = Math.round(ctx.window / 1000)
    return { status: pct >= 85 ? 'fail' : pct >= 50 ? 'warn' : 'ok', detail: `${pct}% of ${kt}k used` }
  } catch {
    return { status: 'skip', detail: 'usage unavailable' }
  }
}

async function checkDisk($: EngineInterface, budget: Budget, cwd: string): Promise<Result> {
  // -P keeps each filesystem on one line, however long its name.
  const r = await run($, budget, ['df', '-Pk', cwd])
  if (r === null) return budget.timedOut ? null : { status: 'skip', detail: 'df failed' }
  if (r.code !== 0) return { status: 'skip', detail: 'df failed' }
  const cols = (r.out.split('\n')[1] ?? '').trim().split(/\s+/)
  const freeKb = Number(cols[3])
  const usedPct = Number(String(cols[4] ?? '').replace('%', ''))
  if (!Number.isFinite(freeKb)) return { status: 'skip', detail: 'df output unreadable' }
  const gb = freeKb / 1048576
  const full = Number.isFinite(usedPct) ? ` · ${usedPct}% used` : ''
  const isFail = gb < 2 || usedPct >= 97
  const isWarn = gb < 10 || usedPct >= 90
  return { status: isFail ? 'fail' : isWarn ? 'warn' : 'ok', detail: `${gb.toFixed(1)} GB free${full}` }
}

async function runCheck($: EngineInterface, budget: Budget, id: string, cwd: string): Promise<Result> {
  switch (id) {
    case 'cpu':
      return checkCpu($, budget)
    case 'git':
      return checkGit($, budget, cwd)
    case 'toolchain':
      return checkToolchain($, budget)
    case 'devices':
      return checkDevices($, budget)
    case 'ports':
      return checkPorts($, budget)
    case 'mods':
      return checkMods($)
    case 'context':
      return checkContext($)
    case 'disk':
      return checkDisk($, budget, cwd)
    default:
      return null
  }
}

// ---------------------------------------------------------------- the boot

function typedLength(lines: Line[]): number {
  return lines.reduce((n, l) => n + l.label.length + l.detail.length + 12, 0)
}

function stopTicking() {
  tickerGen += 1
  if (stopTicker !== null) stopTicker()
  stopTicker = null
}

async function startTicker($: EngineInterface, animate: boolean) {
  stopTicking()
  const gen = tickerGen
  if (!animate) {
    await update($, tick, () => 1_000_000)
    return
  }
  await update($, tick, () => 0)
  // A newer boot started while this one awaited: it owns the clock.
  if (gen !== tickerGen) return
  // The callback returns advance's promise, so a slow frame never overlaps the next.
  const handle = $.clock.every(FRAME_MS, () => advance($))
  stopTicker = () => handle.cancel()
}

async function advance($: EngineInterface) {
  const now = await update($, tick, n => n + 1)
  const b = await read($, boot)
  if (b === null) {
    stopTicking()
    return
  }
  const typedOut = b.isDone && now > LOGO_TICKS + typedLength(b.lines) / CHARS_PER_TICK + 10
  // Folded or hidden in the band, nothing animates on screen: stop the clock.
  const offScreen = b.where === 'band' && ((await read($, isCollapsed)) || (await read($, isHidden)))
  if (typedOut || offScreen) {
    stopTicking()
    if (typedOut && b.where === 'band') armCollapse($, b.run, lastOptions)
  }
}

let lastOptions: Options = {}

/** Folds the band boot a while after its log has been fully typed (once per boot). */
function armCollapse($: EngineInterface, seq: number, options: Options) {
  if (collapseArmedFor === seq) return
  collapseArmedFor = seq
  const wait = Math.max(1, options.collapseSeconds ?? 8) * 1000
  $.clock.after(wait, () => {
    void collapseIf($, seq)
  })
}

async function startBoot($: EngineInterface, where: 'band' | 'pane', options: Options) {
  runSeq += 1
  const seq = runSeq
  const animate = options.animate !== false
  lastOptions = options
  const budget: Budget = { seq, deadline: (await $.clock.now()) + DEADLINE_MS, timedOut: false }
  // A watchdog: whatever a check is still awaiting, the boot finishes shortly after its deadline.
  $.clock.after(DEADLINE_MS + 1000, () => {
    void finish($, seq, where, options)
  })
  // A boot in the band that starts after the person has already prompted stays folded.
  const folded = where === 'band' && (await read($, hasPrompted))
  await update($, isCollapsed, () => folded)
  await update($, isHidden, () => false)
  await update($, boot, (): Boot => ({ run: seq, lines: [], memoryMb: 0, isDone: false, where }))
  await startTicker($, animate)
  try {
    const cwd = await $.session.cwd()
    const memory = await checkMemory($, budget)
    await update($, boot, cur => (cur !== null && cur.run === seq ? { ...cur, memoryMb: memory } : cur))
    for (const id of IDS) {
      if (budget.seq !== runSeq) return
      const label = LABELS[id] ?? id.toUpperCase()
      if (!(await isLive($, budget))) {
        // Out of time: say so instead of leaving the line out.
        const skipped: Line = { id, label, status: 'skip', detail: 'time limit' }
        await update($, boot, (cur): Boot | null => (cur !== null && cur.run === seq ? { ...cur, lines: [...cur.lines, skipped] } : cur))
        continue
      }
      const pending: Line = { id, label, status: 'run', detail: '' }
      await update($, boot, (cur): Boot | null => (cur !== null && cur.run === seq ? { ...cur, lines: [...cur.lines, pending] } : cur))
      budget.timedOut = false
      const raw = await runCheck($, budget, id, cwd)
      // Part of a check ran out of time: keep what it saw, but never call it complete.
      const result: Result =
        raw !== null && budget.timedOut && raw.status !== 'skip'
          ? { status: raw.status === 'ok' ? 'warn' : raw.status, detail: `${raw.detail} · partial (timed out)` }
          : raw
      const timedOut = result === null && budget.seq === runSeq && (budget.timedOut || !(await isLive($, budget)))
      await update($, boot, (cur): Boot | null => {
        if (cur === null || cur.run !== seq || cur.isDone) return cur
        let lines: Line[]
        if (result !== null) lines = cur.lines.map((l): Line => (l.id === id ? { ...l, status: result.status, detail: result.detail } : l))
        else if (timedOut) lines = cur.lines.map((l): Line => (l.id === id ? { ...l, status: 'skip', detail: 'timed out' } : l))
        // A missing tool is skipped silently: its line goes away.
        else lines = cur.lines.filter(l => l.id !== id)
        return { ...cur, lines }
      })
    }
  } catch {
    // Whatever failed, say so: the boot below still finishes and folds, but never as OK.
    await update($, boot, (cur): Boot | null =>
      cur !== null && cur.run === seq && !cur.isDone
        ? { ...cur, lines: [...cur.lines, { id: 'boot', label: 'BOOT', status: 'fail', detail: 'a check crashed; results incomplete' }] }
        : cur,
    )
  } finally {
    await finish($, seq, where, options)
  }
}

async function finish($: EngineInterface, seq: number, where: 'band' | 'pane', options: Options) {
  let wasDone = false
  const done = await update($, boot, (cur): Boot | null => {
    if (cur === null || cur.run !== seq) return cur
    wasDone = cur.isDone
    if (cur.isDone) return cur
    // Anything still marked running when the boot ends did not finish.
    const lines = cur.lines.map((l): Line => (l.status === 'run' ? { ...l, status: 'skip', detail: 'did not finish' } : l))
    return { ...cur, lines, isDone: true }
  })
  if (done === null || done.run !== seq || wasDone) return
  // Animated, the collapse is armed once the log has been typed out (in advance); still, it is armed now.
  if (where === 'band' && (options.animate === false || stopTicker === null)) armCollapse($, seq, options)
}

async function collapseIf($: EngineInterface, seq: number) {
  const b = await read($, boot)
  if (b !== null && b.run === seq) await update($, isCollapsed, () => true)
}

async function registerBoot($: EngineInterface) {
  try {
    await $.command.register({ name: 'boot', description: 'Boot Sequence: replay the boot screen and its checks in a pane', immediate: true })
  } catch {
    // Commands are a convenience; the boot still runs.
  }
}

/** The session's own boot, unless a /boot replay already started one. */
async function startupBoot($: EngineInterface, options: Options) {
  if ((await read($, boot)) !== null) return
  await startBoot($, 'band', options)
}

export function tally(lines: Line[]): Record<Status, number> {
  const out: Record<Status, number> = { run: 0, ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const l of lines) out[l.status] += 1
  return out
}

// ---------------------------------------------------------------- drawing

type Els = ReturnType<EngineInterface['ui']['resolve']>

function typed(text: string, budget: number): string {
  return budget >= text.length ? text : text.slice(0, Math.max(0, budget))
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown }

/** The rows a drawn tree takes: a Raster its rows, a column Box the sum, a row Box the tallest. */
export function heightOf(el: unknown, columns = 80): number {
  const wrapped = (text: string) => text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(1, columns))), 0)
  if (el === null || el === undefined || el === false || el === true) return 0
  if (typeof el === 'string' || typeof el === 'number') return wrapped(String(el))
  if (Array.isArray(el)) return el.reduce((n: number, c) => n + heightOf(c, columns), 0)
  const node = el as Node
  if (node.type === 'Raster') return Number(node.props?.rows ?? 1)
  const kids = Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]
  if (node.type === 'Text') {
    const text = kids.map(k => (typeof k === 'string' || typeof k === 'number' ? String(k) : '')).join('')
    return Math.max(1, wrapped(text))
  }
  if (node.type === 'Box') {
    if (node.props?.flexDirection === 'column') return kids.reduce((n: number, c) => n + heightOf(c, columns), 0)
    return Math.max(kids.length === 0 ? 0 : 1, ...kids.map(k => heightOf(k, columns)))
  }
  // Anything else: assume it may take two rows, so the other mods are never pushed out of view.
  return 2
}

/** The full boot log at a tick, fitted into `room` rows: logo, BIOS header, memory test, then each check typed out. */
function logTree(els: Els, b: Boot, at: number, columns: number, room: number, isTerminal: boolean): RenderElement[] {
  const { Box, Text } = els
  const rows: RenderElement[] = []
  let used = 0
  const hasRaster = isTerminal && 'Raster' in els && columns >= LOGO_COLS + 2 && room >= LOGO_ROWS + 4
  if (hasRaster) {
    const Raster = (els as { Raster: (p: { key: string; columns: number; rows: number; cells: string }) => RenderElement }).Raster
    rows.push(<Raster key="logo" columns={LOGO_COLS} rows={LOGO_ROWS} cells={logoCells(at)} />)
    used += LOGO_ROWS
  } else {
    rows.push(<Text key="logo" color="#89dceb" bold>{'▓▒░ CLAUDE CODE ░▒▓'}</Text>)
    used += 1
  }
  const sinceLogo = Math.max(0, at - LOGO_TICKS)
  let budget = sinceLogo * CHARS_PER_TICK
  const header = 'CLAUDE CODE BIOS · POWER-ON SELF TEST'
  if (room - used >= 2) {
    rows.push(<Text key="hdr" color="#94e2d5">{typed(header, budget)}</Text>)
    used += 1
  }
  budget -= header.length
  if (b.memoryMb > 0 && budget > 0 && room - used >= 2) {
    const target = b.memoryMb * 1024
    const shown = Math.min(target, Math.round((target * Math.min(sinceLogo, 30)) / 30))
    const done = shown >= target
    rows.push(
      <Box key="mem">
        <Text color="#cdd6f4">{`MEMORY TEST  ${String(shown).padStart(9)}K `}</Text>
        <Text color={done ? COLOR.ok : COLOR.run}>{done ? 'OK' : '..'}</Text>
      </Box>,
    )
    used += 1
  }
  const lineRows: RenderElement[] = []
  // Short of room, warnings and failures come first, then the rest in check order.
  const keep = Math.max(1, room - used)
  const ordered = b.lines.length <= keep ? b.lines : [...b.lines.filter(l => l.status === 'fail' || l.status === 'warn'), ...b.lines.filter(l => l.status !== 'fail' && l.status !== 'warn')].slice(0, keep)
  const shownIds = new Set(ordered.map(l => l.id))
  for (const l of b.lines.filter(x => shownIds.has(x.id))) {
    if (budget <= 0) break
    const left = `${l.label.padEnd(10)} `
    const detailRoom = Math.max(8, columns - left.length - 11)
    const detail = l.detail.length > detailRoom ? `${l.detail.slice(0, detailRoom - 1)}…` : l.detail
    const shownLeft = typed(left + detail, budget)
    budget -= left.length + detail.length
    const finished = budget >= 0
    const spin = '⣾⣽⣻⢿⡿⣟⣯⣷'[at % 8] as string
    const badge = l.status === 'run' ? `[ ${spin}${spin}${spin}${spin} ]` : BADGE[l.status]
    lineRows.push(
      <Box key={`l-${l.id}`}>
        <Text color={COLOR[l.status]}>{finished ? badge : '[      ]'}</Text>
        <Text color="#cdd6f4">{` ${shownLeft}`}</Text>
        {!finished && <Text color="#a6e3a1">{at % 2 === 0 ? '█' : ' '}</Text>}
      </Box>,
    )
  }
  return [...rows, ...lineRows]
}

function summaryText(b: Boot): string {
  const t = tally(b.lines)
  const verdict = b.lines.length === 0 || t.fail > 0 ? 'FAIL' : t.warn > 0 ? 'WARN' : t.skip > 0 ? 'PARTIAL' : 'OK'
  const skipped = t.skip > 0 ? ` · ${t.skip} skipped` : ''
  return `▣ BOOT ${verdict}  ${t.ok} ok · ${t.warn} warn · ${t.fail} fail${skipped}`
}

function summaryColor(b: Boot): string {
  const t = tally(b.lines)
  return b.lines.length === 0 || t.fail > 0 ? COLOR.fail : t.warn > 0 ? COLOR.warn : t.skip > 0 ? COLOR.skip : COLOR.ok
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const opts = options as Options

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    // Neither the command nor the boot holds up the session's start.
    void registerBoot($)
    if (e.isInteractive) {
      $.clock.after(400, () => {
        void startupBoot($, opts)
      })
    }
    return out
  })

  on('command.run', { command: 'boot' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Boot sequence' })
    void startBoot($, 'pane', opts)
    return { text: 'Boot Sequence: replaying the boot checks.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const out = await next(e)
    // Only a prompt that actually entered folds the boot; a refused one changes nothing.
    if (out.drop === undefined && PERSON.includes(e.origin.kind)) {
      await update($, hasPrompted, () => true)
      await update($, isCollapsed, () => true)
    }
    return out
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, boot)
    if (b === null || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // The rows the band shows at once, less what the mods beneath it need and the skip row.
    const window = Math.max(1, e.props.scroll?.bodyRows ?? e.props.maxRows)
    const cols = Math.max(20, e.props.bodyColumns)
    const room = window - heightOf(below, cols) - 1
    const collapsed = (await read($, isCollapsed)) || b.where === 'pane' || room < 4
    if (collapsed) {
      if (!b.isDone && b.where === 'pane') return below
      // The band is full with the mods beneath: add nothing rather than push them out.
      if (room < 0) return below
      const full = b.isDone ? summaryText(b) : `▣ BOOT  running ${b.lines.filter(l => l.status !== 'run').length}/${IDS.length}`
      const label = full.length > cols - 10 ? `${full.slice(0, Math.max(10, cols - 11))}…` : full
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={b.isDone ? summaryColor(b) : COLOR.run}>{label}</Text>
            <Text dimColor>{'  /boot '}</Text>
            <Button key="hide" label="x" plain onPress={() => update($, isHidden, () => true)} />
          </Box>
          {below}
        </Box>
      )
    }
    const at = await read($, tick)
    const columns = Math.max(20, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {logTree($.ui.resolve(e), b, at, columns, Math.min(room, 16), e.surface === 'terminal')}
        <Box>
          <Button key="skip" label="skip" hotkey="s" onPress={() => update($, isCollapsed, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, boot)
    if (b === null) return <Text dimColor>Starting…</Text>
    const at = await read($, tick)
    const columns = Math.max(20, e.props.bodyColumns)
    const room = Math.max(6, (e.viewport?.rows ?? 30) - 4)
    return (
      <Box flexDirection="column">
        {logTree($.ui.resolve(e), b, at, columns, room, e.surface === 'terminal')}
        {b.isDone && <Text color="#94e2d5">{`\n${summaryText(b)}  ·  READY.`}</Text>}
      </Box>
    )
  })
}
