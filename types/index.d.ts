export type Status = 'run' | 'ok' | 'warn' | 'fail' | 'skip'
export type Line = { id: string; label: string; status: Status; detail: string }
export type Boot = {
  /** Bumped on every boot, so a stale run never writes into a newer one. */
  run: number
  lines: Line[]
  memoryMb: number
  isDone: boolean
  /** Where the full log draws: the band above the prompt, or the /boot pane. */
  where: 'band' | 'pane'
}

declare module 'claude-code' {
  interface PluginState {
    'boot-sequence': {
      boot: Boot | null
      tick: number
      isCollapsed: boolean
      isHidden: boolean
      hasPrompted: boolean
    }
  }
}
