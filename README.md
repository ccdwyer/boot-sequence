# Boot Sequence

![Boot Sequence demo](media/demo.gif)

[Watch the MP4](https://github.com/ccdwyer/claude-mods/raw/main/media/boot-sequence.mp4) · [Screenshot](media/02-checks.png) · [Screenshot](media/03-summary.png)

A BIOS-style boot screen for Claude Code. When a session starts, a gradient `CLAUDE CODE` wordmark sweeps in under a scanline, a memory test counts up, and a POST log types itself out above the prompt. Every line is a real check of your machine, and each one flips from a spinner to `[  OK  ]`, `[ WARN ]` or `[ FAIL ]`:

| Check | What it reports | Warns when |
|---|---|---|
| CPU | OS, architecture, core count | |
| GIT | branch, changed files, ahead/behind upstream | not a repo, or behind upstream |
| TOOLCHAIN | node, pnpm, python, xcode, java versions (whatever is installed) | |
| DEVICES | booted iOS simulators and Android devices | |
| PORTS | dev servers listening (3000, 5173, 8081, 19000…) | |
| MODS | plugins that registered commands | |
| CONTEXT | context window used | ≥50% (fails at ≥85%) |
| DISK | free space on the project's disk | under 10 GB (fails under 2 GB) |

Missing tools are skipped silently. The checks start after the prompt is ready and share a hard 5-second budget (each command gets at most 1.5 s of it), so startup is never slower. The checks that can fail, context and disk, run first. A check that runs out of time shows `[ SKIP ]`, a check that only partly finished is marked `partial (timed out)`, and the summary says `PARTIAL` or `FAIL` instead of pretending everything is fine. Disk warns at 90% used (or under 10 GB free) and fails at 97% (or under 2 GB). Git runs with `--no-optional-locks`, so the boot never takes the index lock.

If the band above the prompt is too short to show the log and the other mods' rows, it shows only the one-line summary.

When the log finishes it folds into a one-line summary (`▣ BOOT OK  7 ok · 1 warn · 0 fail`), as soon as you send a prompt or after a few seconds. Click `skip` (or press `s` while the band has focus, after a click or ctrl+x tab) to fold it early, `x` to hide the summary, and `/boot` to replay the whole sequence in a pane.

## Settings

- **Animate the boot screen** (on): off shows the finished log at once, with no typewriter or scanline.
- **Collapse after (seconds)** (8): how long the finished log stays open.

The pixel logo uses a `Raster`, so it draws in the terminal. Other surfaces get the same log as plain text.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install boot-sequence@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## What it hooks

- `session.start`: registers `/boot` and, in an interactive session, starts the boot 400 ms after the prompt is ready.
- `command.run{command=boot}`: replays the boot in a pane.
- `prompt.submit`: folds the log into its summary when you send a prompt (your own prompts only, not background notifications).
- `ui.render{component=AbovePrompt}`: draws the boot log or its summary, composed above whatever other mods draw there.
- `ui.render{component=Pane}`: draws the `/boot` replay.

It never refuses, rewrites or delays a tool call or a prompt.

## Privacy

It runs entirely on your machine and sends nothing over the network. Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT
