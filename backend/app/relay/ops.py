"""ops.py — where the configuration comes from (§15.18/O1).

Three layers, resolved here in one direction only:

```
defaults  <  relay.toml (read-only mount)  <  env
```

O1's reason for a file at all: a container env blob is invisible to the operator
who inherits the host, and a config file can be read, diffed, and mounted
read-only. The reason env still wins: a one-off override for a Gate G run must
not require editing a mounted file.

`tomllib` is stdlib on 3.11+, so the file loader adds no dependency. That is
also why pydantic-settings, python-dotenv and PyYAML are not needed (G7).

Deliberately NOT here:

- `REVOKED_TOKENS_FILE` / `LICENSE_VERIFY_PUBKEY` / SIGHUP reload. They belong
  to the paid mailbox (§15.18), which is step 7. Adding them now would imply the
  relay authorizes something, and it does not (§10).
- `PORT` / `RELAY_HOST`. Those are process arguments, not relay knobs.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import fields, replace
from pathlib import Path
from typing import Any

from .constants import KNOBS, RelayConfig

# `RELAY_CONFIG` names the file; the default is the path compose mounts.
CONFIG_ENV = "RELAY_CONFIG"
DEFAULT_PATH = "/etc/owlshelf/relay.toml"

# Fields that can only come from the file. `moved` is a map, and `trust_...` is
# resolved by RELAY_TOPOLOGY; neither is a scalar an env var can express well.
_FILE_ONLY = frozenset({"moved", "trust_forwarded_for", "extra"})

# TOML uses kebab-case in the example file and snake_case is the dataclass. Both
# spellings are accepted so a config written from the plan's prose still loads.
_KNOWN = {knob.field for knob in KNOBS} | _FILE_ONLY


class ConfigError(Exception):
    """A relay.toml that cannot be applied. Never a warning: a config typo must
    fail the boot, because the alternative is a relay that runs on defaults the
    operator believes they overrode."""


def _coerce(field_name: str, value: Any, default: Any) -> Any:
    """Type-check against the dataclass default rather than trusting TOML."""
    if isinstance(default, bool) and not isinstance(value, bool):
        raise ConfigError(f"{field_name}: expected true/false, got {value!r}")
    if isinstance(default, int) and not isinstance(default, bool):
        if not isinstance(value, int) or isinstance(value, bool):
            raise ConfigError(f"{field_name}: expected an integer, got {value!r}")
        return value
    if isinstance(default, float):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ConfigError(f"{field_name}: expected a number, got {value!r}")
        return float(value)
    if isinstance(default, str):
        if not isinstance(value, str):
            raise ConfigError(f"{field_name}: expected a string, got {value!r}")
        return value
    if isinstance(default, tuple):
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ConfigError(f"{field_name}: expected a list of strings, got {value!r}")
        return tuple(value)
    return value


def read_toml(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Parse one relay.toml into a `RelayConfig` field dict.

    Every unknown key is an error. A silently ignored `conns_per_ip` typo is the
    same class of defect as G2: the operator gets a relay that behaves nothing
    like the file says, and nothing tells them.
    """
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    defaults = RelayConfig()
    overrides: dict[str, Any] = {}

    for key, value in raw.items():
        name = key.replace("-", "_")
        if name == "moved":
            if not isinstance(value, dict):
                raise ConfigError("moved: expected a table of path -> relay URL")
            overrides["moved"] = tuple(
                (str(k), str(v)) for k, v in value.items()  # type: ignore[union-attr]
            )
            continue
        if name not in _KNOWN:
            raise ConfigError(f"unknown key {key!r}; known keys: {sorted(_KNOWN)}")
        overrides[name] = _coerce(name, value, getattr(defaults, name))

    return overrides


def load_config(
    path: str | os.PathLike[str] | None = None,
    *,
    env: dict[str, str] | None = None,
) -> RelayConfig:
    """Resolve defaults < relay.toml < env, then log which file was used.

    A missing file is not an error when the path was taken from the default: a
    developer running `python main.py` has no `/etc/owlshelf/relay.toml`. A
    missing file IS an error when `RELAY_CONFIG` names one, because that is an
    operator saying "this file exists".
    """
    environ = os.environ if env is None else env
    explicit = environ.get(CONFIG_ENV, "").strip()
    target = path if path is not None else (explicit or DEFAULT_PATH)

    base = RelayConfig()
    file_overrides: dict[str, Any] = {}
    if target and Path(target).is_file():
        file_overrides = read_toml(target)
    elif path is not None or explicit:
        raise ConfigError(f"RELAY_CONFIG points at {target}, which does not exist")

    if file_overrides:
        base = replace(base, **file_overrides)

    return RelayConfig.from_env(base, environ)


def source_summary(cfg: RelayConfig, path: str | None = None) -> str:
    """One line naming where the config came from, for the boot log."""
    named = path or os.environ.get(CONFIG_ENV, "").strip()
    file_state = f"{named}" if named else f"{DEFAULT_PATH} (optional)"
    env_names = sorted(knob.env for knob in KNOBS if os.environ.get(knob.env, "").strip())
    return (
        f"config: file={file_state} "
        f"env-overrides={','.join(env_names) if env_names else 'none'} "
        f"fields={len(fields(cfg))}"
    )
