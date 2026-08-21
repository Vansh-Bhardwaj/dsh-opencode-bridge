#!/usr/bin/env python3
"""Atomically synchronize DSH's OpenCode Go and Zen model routes.

Availability comes from OpenCode's authenticated /models endpoints. Metadata is
merged from the live response and models.dev. The last good settings document
is retained when either live catalog is unavailable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
SETTINGS = DSH_HOME / "settings.yaml"
CREDENTIALS = DSH_HOME / ".credentials.yaml"
OPENCODE_AUTH = Path.home() / ".local" / "share" / "opencode" / "auth.json"
CACHE_DIR = DSH_HOME / "cache"
CATALOG_CACHE = CACHE_DIR / "modelsdev-catalog.json"
STATE_FILE = CACHE_DIR / "opencode-model-sync.json"

CATALOG_URLS = (
    "https://models.dev/catalog.json",
    "https://modelsdev-mirror.onesoft.top/catalog.json",
)
GO_URL = "https://opencode.ai/zen/go/v1/models"
ZEN_URL = "https://opencode.ai/zen/v1/models"
ZEN_FREE_EXTRA = {"big-pickle"}
DEFAULT_CONTEXT = 262_144
DEFAULT_OUTPUT = 32_768
SUPPORTED_INPUTS = ("text", "image")

KNOWN_OVERRIDES = {
    "deepseek-v4-flash-vision-exp": {
        "name": "DeepSeek V4 Flash Vision Exp",
        "context": 1_000_000,
        "output": 384_000,
        "reasoning": True,
        "input": ["text", "image"],
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def log(message: str, quiet: bool = False, *, error: bool = False) -> None:
    if quiet and not error:
        return
    print(message, file=sys.stderr if error else sys.stdout)


def read_key() -> str | None:
    value = os.environ.get("OPENCODE_GO_API_KEY", "").strip()
    if value:
        return value
    try:
        for line in CREDENTIALS.read_text(encoding="utf-8").splitlines():
            match = re.match(r"\s*OPENCODE_GO_API_KEY\s*:\s*([^#\s]+)", line)
            if match:
                return match.group(1).strip("'\"")
    except OSError:
        pass
    try:
        auth = json.loads(OPENCODE_AUTH.read_text(encoding="utf-8"))
        value = str(auth.get("opencode-go", {}).get("key", "")).strip()
        return value or None
    except (OSError, ValueError, TypeError):
        return None


def request_json(url: str, key: str | None = None, timeout: int = 30):
    headers = {"Accept": "application/json", "User-Agent": "dsh-ocui-sync/2.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def fetch_live_models(url: str, key: str) -> list[dict]:
    payload = request_json(url, key)
    rows = payload if isinstance(payload, list) else payload.get("data", payload.get("models", []))
    if not isinstance(rows, list):
        raise ValueError(f"{url} returned no model list")
    result = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id", "")).strip()
        if model_id and model_id not in seen:
            seen.add(model_id)
            result.append(row)
    if not result:
        raise ValueError(f"{url} returned an empty model list")
    return result


def load_modelsdev() -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for url in CATALOG_URLS:
        try:
            payload = request_json(url)
            if isinstance(payload, dict) and isinstance(payload.get("providers"), dict):
                atomic_write(CATALOG_CACHE, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                return payload
        except Exception:
            continue
    try:
        payload = json.loads(CATALOG_CACHE.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload
    except (OSError, ValueError):
        pass
    return {"providers": {}}


def catalog_entry(catalog: dict, provider_ids: tuple[str, ...], model_id: str) -> dict:
    providers = catalog.get("providers", {})
    candidates = [model_id]
    if model_id.endswith("-free"):
        candidates.append(model_id[:-5])
    if model_id.endswith("-vision-exp"):
        candidates.append(model_id.removesuffix("-vision-exp"))
    for provider_id in provider_ids:
        models = providers.get(provider_id, {}).get("models", {})
        for candidate in candidates:
            entry = models.get(candidate)
            if isinstance(entry, dict):
                return entry
    return {}


def positive_int(*values, fallback: int) -> int:
    for value in values:
        if isinstance(value, bool):
            continue
        try:
            parsed = int(value)
            if parsed > 0:
                return parsed
        except (TypeError, ValueError):
            continue
    return fallback


def live_modalities(row: dict) -> list[str]:
    modalities = row.get("modalities", {})
    values = row.get("input_modalities") or row.get("input")
    if not values and isinstance(modalities, dict):
        values = modalities.get("input")
    return [item for item in (values or []) if item in SUPPORTED_INPUTS]


def reasoning_efforts(entry: dict, live: dict) -> list[str]:
    if live.get("reasoning") is False or entry.get("reasoning") is False:
        return []
    options = live.get("reasoning_options") or entry.get("reasoning_options") or []
    values = []
    for option in options:
        if isinstance(option, dict):
            values.extend(option.get("values", []))
    if not (live.get("reasoning") or entry.get("reasoning") or values):
        return []
    ordered = [value for value in ("minimal", "low", "medium", "high", "xhigh", "max") if value in values]
    return ordered or ["low", "high"]


def pretty_name(model_id: str) -> str:
    return " ".join(part.upper() if part in {"gpt", "glm"} else part.capitalize() for part in re.split(r"[-_]", model_id))


def resolve_metadata(catalog: dict, providers: tuple[str, ...], live: dict) -> dict:
    model_id = str(live["id"])
    entry = catalog_entry(catalog, providers, model_id)
    override = KNOWN_OVERRIDES.get(model_id, {})
    limits = entry.get("limit", {}) if isinstance(entry.get("limit"), dict) else {}
    live_limits = live.get("limit", {}) if isinstance(live.get("limit"), dict) else {}
    inputs = live_modalities(live)
    if not inputs:
        inputs = [item for item in entry.get("modalities", {}).get("input", []) if item in SUPPORTED_INPUTS]
    if not inputs:
        inputs = list(override.get("input", []))
    if not inputs:
        inputs = ["text", "image"] if re.search(r"(?:vision|omni|[-_.]vl(?:[-_.]|$)|multimodal)", model_id, re.I) else ["text"]
    if "text" not in inputs:
        inputs.insert(0, "text")
    efforts = reasoning_efforts(entry, live)
    if override.get("reasoning") and not efforts:
        efforts = ["low", "high"]
    return {
        "id": model_id,
        "name": str(live.get("name") or entry.get("name") or override.get("name") or pretty_name(model_id)),
        "context": positive_int(live.get("context_window"), live_limits.get("context"), limits.get("context"), override.get("context"), fallback=DEFAULT_CONTEXT),
        "output": positive_int(live.get("max_output_tokens"), live_limits.get("output"), limits.get("output"), override.get("output"), fallback=DEFAULT_OUTPUT),
        "input": list(dict.fromkeys(inputs)),
        "efforts": efforts,
    }


def is_free(model_id: str) -> bool:
    return model_id.endswith("-free") or model_id in ZEN_FREE_EXTRA


def family_key(model: dict):
    model_id = model["id"]
    for family in ("deepseek", "glm", "gpt", "grok", "hy", "kimi", "mimo", "minimax", "qwen", "nemotron", "gemini", "claude"):
        if model_id.startswith(family):
            return family, model_id
    return "zz-other", model_id


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def model_block(model: dict) -> str:
    lines = [
        f"        - id: {yaml_string(model['id'])}",
        f"          name: {yaml_string(model['name'])}",
        f"          contextWindow: {model['context']}",
        f"          maxTokens: {model['output']}",
        "          input:",
    ]
    lines.extend(f"            - {item}" for item in model["input"])
    if model["efforts"]:
        lines.extend(("          reasoningEfforts:", "            off:"))
        lines.extend(f"            {effort}: {effort}" for effort in model["efforts"])
    return "\n".join(lines)


def preserve_other_sections(text: str) -> str:
    kept = []
    for block in re.split(r"(?=^\S[^\n]*:\s*(?:#.*)?$)", text, flags=re.M):
        match = re.match(r"(\S+):", block)
        if match and match.group(1) not in {"llm-pi-ai", "agent-default-model"}:
            kept.append(block.rstrip())
    return "\n\n".join(kept)


def current_default(text: str, go_ids: set[str]) -> tuple[str, str]:
    section = re.search(r"(?ms)^agent-default-model:\s*\n(?P<body>(?:^[ \t].*\n?)*)", text)
    provider = "opencode-go"
    model = "qwen3.7-plus" if "qwen3.7-plus" in go_ids else sorted(go_ids)[0]
    if section:
        provider_match = re.search(r"(?m)^\s+provider:\s*['\"]?([^'\"\s#]+)", section.group("body"))
        model_match = re.search(r"(?m)^\s+model:\s*['\"]?([^'\"\s#]+)", section.group("body"))
        if provider_match and model_match and provider_match.group(1) == "opencode-go" and model_match.group(1) in go_ids:
            provider, model = provider_match.group(1), model_match.group(1)
    return provider, model


def render_settings(existing: str, go_models: list[dict], zen_models: list[dict]) -> str:
    go_ids = {model["id"] for model in go_models}
    provider, default_model = current_default(existing, go_ids)
    go_body = "\n".join(model_block(model) for model in sorted(go_models, key=family_key))
    zen_body = "\n".join(model_block(model) for model in sorted(zen_models, key=family_key))
    other = preserve_other_sections(existing)
    rendered = f'''# DSH model routes generated from live OpenCode availability plus models.dev metadata.
# Run sync-dsh-models.py manually at any time; OCUI also refreshes it periodically.

llm-pi-ai:
  providers:
    opencode-go:
      displayName: Paid (OpenCode Go)
      apiKeyEnv: OPENCODE_GO_API_KEY
      api: openai-completions
      baseURL: https://opencode.ai/zen/go/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
{go_body}
    opencode-zen-free:
      displayName: Free (OpenCode Zen)
      apiKeyEnv: OPENCODE_GO_API_KEY
      api: openai-completions
      baseURL: https://opencode.ai/zen/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
{zen_body}

agent-default-model:
  provider: {provider}
  model: {default_model}
'''
    if other:
        rendered += "\n" + other + "\n"
    return rendered


def write_state(status: str, go_count: int, zen_count: int, changed: bool, error: str | None = None) -> None:
    state = {
        "checkedAt": int(time.time() * 1000),
        "status": status,
        "changed": changed,
        "goModels": go_count,
        "zenFreeModels": zen_count,
    }
    if error:
        state["error"] = error
    atomic_write(STATE_FILE, json.dumps(state, indent=2) + "\n")


def main() -> int:
    args = parse_args()
    key = read_key()
    if not key:
        message = "OPENCODE_GO_API_KEY is not configured"
        write_state("error", 0, 0, False, message)
        log(f"ERROR: {message}", args.quiet, error=True)
        return 1
    try:
        go_live = fetch_live_models(GO_URL, key)
        zen_live = fetch_live_models(ZEN_URL, key)
    except Exception as exc:
        write_state("error", 0, 0, False, str(exc))
        log(f"ERROR: live OpenCode discovery failed; retained last-good settings: {exc}", args.quiet, error=True)
        return 1
    catalog = load_modelsdev()
    go_models = [resolve_metadata(catalog, ("opencode-go", "opencode"), row) for row in go_live]
    zen_models = [resolve_metadata(catalog, ("opencode", "opencode-go"), row) for row in zen_live if is_free(str(row.get("id", "")))]
    if not zen_models:
        message = "live Zen catalog contained no recognized free models"
        write_state("error", len(go_models), 0, False, message)
        log(f"ERROR: {message}; retained last-good settings", args.quiet, error=True)
        return 1
    existing = SETTINGS.read_text(encoding="utf-8") if SETTINGS.exists() else ""
    rendered = render_settings(existing, go_models, zen_models)
    changed = rendered != existing.replace("\r\n", "\n")
    if changed and not args.dry_run:
        atomic_write(SETTINGS, rendered)
    write_state("ok", len(go_models), len(zen_models), changed and not args.dry_run)
    action = "would update" if args.dry_run and changed else "updated" if changed else "unchanged"
    log(f"OpenCode catalog {action}: {len(go_models)} Go, {len(zen_models)} Zen-free models", args.quiet)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
