# Contributing

Thanks for helping improve DSH OpenCode Bridge.

## Before opening a pull request

1. Keep changes focused and avoid committing credentials, DSH profiles, caches, or sessions.
2. Preserve the plugin's native DSH visual language and keyboard behavior.
3. Prefer live capability metadata over hard-coded model assumptions.
4. Run the local checks:

```powershell
node --check ./plugin/lib/index.js
node --check ./plugin/lib/client.js
python -m py_compile ./scripts/sync-dsh-models.py
```

5. Test installation against a disposable DSH home when installer behavior changes:

```powershell
./install.ps1 -DshHome (Join-Path $PWD 'work/test-dsh-home')
```

## Pull requests

Describe the user-visible behavior, list the models or providers tested, and attach before/after screenshots for UI changes. Do not include screenshots containing personal workspace names, local paths, prompts, credentials, or account data.

By contributing, you agree that your contribution is licensed under the MIT License.
