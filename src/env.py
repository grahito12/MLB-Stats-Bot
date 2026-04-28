"""Small .env loader for optional Python data-source clients."""

from __future__ import annotations

import os
from pathlib import Path

from .utils import PROJECT_ROOT


def load_dotenv(path: str | Path | None = None) -> None:
    """Load KEY=value lines from .env without overriding existing variables."""
    source = Path(path) if path else PROJECT_ROOT / ".env"
    if not source.exists():
        return
    for line in source.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)

