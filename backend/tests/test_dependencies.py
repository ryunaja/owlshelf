"""test_dependencies.py — the runtime install must not ship the test stack (G7).

`backend/README.md` claimed the runtime file "deliberately does not pull them
in" while it pinned pytest, httpx and pyflakes alongside the app. The claim
cannot be wrong again if a test reads both files.

This is a STATIC check, not an install: a from-scratch `pip install` is the
operator's acceptance step in the README, because a cold install needs the
network and a clean environment, and a test that needs either is a test that
gets skipped in CI.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "requirements.txt"
DEV = ROOT / "requirements-dev.txt"

# Packages that exist only to run the tests or a dev server. None of them may
# appear in the runtime file.
TEST_ONLY = {
    "pytest",
    "pytest-asyncio",
    "httpx",
    "httpcore",
    "certifi",
    "pyflakes",
    "pygments",
    "iniconfig",
    "pluggy",
    "packaging",
    "watchfiles",
}

# Pinned but imported by nothing in `app/` — the G7 finding, kept as a list so a
# re-introduction is caught rather than silently tolerated.
UNUSED = {"pydantic-settings", "python-dotenv", "pyyaml"}

# Import name != distribution name. Only the exceptions need saying.
DISTRIBUTION = {"websockets": "websockets", "fastapi": "fastapi", "starlette": "starlette"}


def parse(path: Path) -> dict[str, str]:
    """`{normalised name: pin}` for one requirements file."""
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name, _, pin = line.partition("==")
        out[name.strip().lower()] = pin.strip()
    return out


def direct_imports() -> set[str]:
    """Every top-level module `app/` and `main.py` import, minus the stdlib."""
    found: set[str] = set()
    sources = [ROOT / "main.py", *sorted((ROOT / "app").rglob("*.py"))]
    for path in sources:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    found.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add(node.module.split(".")[0])
    return {name for name in found if name not in sys.stdlib_module_names and name != "app"}


class TestRuntimeRequirements:
    def test_the_test_stack_is_not_in_the_runtime_install(self):
        names = set(parse(RUNTIME))
        assert names & TEST_ONLY == set(), f"runtime pins: {sorted(names & TEST_ONLY)}"

    def test_the_unused_pins_are_gone(self):
        assert set(parse(RUNTIME)) & UNUSED == set()

    def test_every_import_the_relay_makes_is_pinned(self):
        # A missing pin is a runtime ImportError on a clean host, which is the
        # one failure mode the deployment cannot recover from.
        pinned = set(parse(RUNTIME))
        missing = {
            name
            for name in direct_imports()
            if DISTRIBUTION.get(name, name).lower() not in pinned
        }
        assert missing == set(), f"unpinned imports: {sorted(missing)}"

    def test_uvicorn_is_pinned_because_main_py_needs_it(self):
        assert "uvicorn" in parse(RUNTIME)
        assert "websockets" in parse(RUNTIME), "the --ws websockets-sansio transport"


class TestDevRequirements:
    def test_the_dev_file_builds_on_the_runtime_file(self):
        text = DEV.read_text(encoding="utf-8")
        assert "-r requirements.txt" in text

    def test_the_dev_file_carries_the_test_stack(self):
        names = set(parse(DEV))
        assert {"pytest", "pytest-asyncio", "httpx"} <= names

    def test_every_dev_pin_has_a_version(self):
        for name, pin in parse(DEV).items():
            assert pin, f"{name} is unpinned"
