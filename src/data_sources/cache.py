"""Small local cache helpers for optional external data sources."""

from __future__ import annotations

import csv
import hashlib
import json
import time
from pathlib import Path
from typing import Any, Callable

from ..utils import DATA_DIR


class LocalCache:
    """File-based cache with simple TTL semantics.

    The cache is intentionally boring: JSON in, JSON out. It helps avoid
    repeated API calls and keeps tests/offline workflows deterministic.
    """

    def __init__(self, cache_dir: str | Path | None = None, ttl_seconds: int = 900) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir else DATA_DIR / "cache"
        self.ttl_seconds = ttl_seconds
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, namespace: str, key: str, suffix: str = "json") -> Path:
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
        safe_namespace = "".join(char if char.isalnum() else "_" for char in namespace)
        return self.cache_dir / f"{safe_namespace}_{digest}.{suffix}"

    def get_json(self, namespace: str, key: str) -> Any | None:
        """Return cached JSON payload when present and fresh."""
        path = self._path(namespace, key)
        if not path.exists():
            return None
        if self.ttl_seconds > 0 and time.time() - path.stat().st_mtime > self.ttl_seconds:
            return None
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def set_json(self, namespace: str, key: str, payload: Any) -> Any:
        """Write a JSON payload and return it."""
        path = self._path(namespace, key)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2)
        return payload

    def get_or_set_json(self, namespace: str, key: str, fetcher: Callable[[], Any]) -> Any:
        """Return cached JSON or fetch and store it."""
        cached = self.get_json(namespace, key)
        if cached is not None:
            return cached
        return self.set_json(namespace, key, fetcher())


def read_csv_records(path: str | Path) -> list[dict[str, str]]:
    """Read a CSV file into dictionaries."""
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv_records(path: str | Path, rows: list[dict[str, Any]]) -> None:
    """Write dictionaries to CSV using the union of row keys."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = sorted({key for row in rows for key in row})
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

