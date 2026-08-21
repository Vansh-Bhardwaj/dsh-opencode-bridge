# DSH OpenCode Bridge

A companion plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that makes OpenCode Go and Zen feel native in the DSH web interface.

## Features

- OpenCode-style usage panel with rolling, weekly, and monthly limits.
- Integrated model picker grouped by provider and model family.
- Live OpenCode Go and Zen model discovery.
- Capability, context-window, output-limit, and reasoning metadata from the live catalog plus models.dev.
- Catalog refresh on startup and every 15 minutes with last-good preservation.
- Native image handling for vision-capable models.
- Automatic delegation to DeepSeek V4 Flash Vision Exp when a text-only model calls `read_image`.
- Image chats remain usable after switching to a text-only model because visual context is preserved as text.
- Optional disabling of DSH's direct DeepSeek API, DeepSeek web search, and bundled web tool.

## Repository layout

```text
plugin/
  lib/index.js       Backend integration, discovery, usage, and vision routing
  lib/client.js      Sidebar usage panel and model picker UI
  package.json
scripts/
  sync-dsh-models.py Atomic OpenCode catalog synchronizer
install.ps1          Idempotent Windows installer
```

Credentials, DSH settings, model caches, sessions, and personal paths are intentionally excluded.

## Requirements

- Windows and PowerShell 7.
- DeepSeek Harness (`@deepseek-ai/dsh`), currently tested with `0.1.0-rc.7`.
- An OpenCode Go credential stored in DSH as `OPENCODE_GO_API_KEY`.
- Python 3 for catalog synchronization. The plugin also detects Codex's bundled Python runtime when available.

## Install

From PowerShell:

```powershell
git clone <your-repository-url>
cd dsh-opencode-bridge
./install.ps1
dsh web
```

The installer backs up an existing OCUI plugin, copies the plugin and synchronizer into `~/.dsh`, enables it for the web profile, and disables direct DeepSeek API/search tooling by default.

To retain DSH's direct DeepSeek API and web tooling:

```powershell
./install.ps1 -KeepDeepSeekApi
```

## Verify

```powershell
node --check ./plugin/lib/index.js
node --check ./plugin/lib/client.js
python ./scripts/sync-dsh-models.py --dry-run
dsh web
```

In DSH Web, confirm:

1. The sidebar shows all three OpenCode Go usage windows.
2. The picker lists current Go and Zen-free models.
3. A native vision model can call `read_image`.
4. A text-only model can call `read_image` through the vision worker.
5. A chat containing an image can switch to a text-only model and continue using the preserved visual context.

## Publish to GitHub

This repository is intentionally standalone. Fork the full DeepSeek Harness repository only if you plan to change DSH core; this plugin can track DSH releases independently.

After creating an empty GitHub repository:

```powershell
git remote add origin https://github.com/<username>/dsh-opencode-bridge.git
git push -u origin main
```

Choose a license before making the repository public.

