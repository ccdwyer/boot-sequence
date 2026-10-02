# Privacy

It runs entirely on your machine and sends nothing over the network. At session start it runs read-only local commands (`git`, `uname`, `sysctl`, `node`/`pnpm`/`python3`/`xcodebuild`/`java --version`, `xcrun simctl list`, `adb devices`, `lsof`, `df`) and shows what they report above the prompt. Nothing is stored beyond the current session's boot log.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/boot-sequence/issues
