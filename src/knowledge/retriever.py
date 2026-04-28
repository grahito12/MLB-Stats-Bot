"""Tiny local markdown retriever for baseball knowledge files."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ..utils import DATA_DIR


@dataclass(frozen=True)
class KnowledgeChunk:
    """A searchable markdown chunk."""

    source: str
    heading: str
    text: str


def tokenize(text: str) -> set[str]:
    """Tokenize text into lowercase search terms."""
    return {token for token in re.findall(r"[a-zA-Z0-9%+\-.]+", text.lower()) if len(token) > 1}


def split_markdown(path: str | Path) -> list[KnowledgeChunk]:
    """Split markdown into heading-based chunks."""
    source = Path(path)
    content = source.read_text(encoding="utf-8")
    chunks: list[KnowledgeChunk] = []
    current_heading = source.stem
    current_lines: list[str] = []

    for line in content.splitlines():
        if line.startswith("#"):
            if current_lines:
                chunks.append(
                    KnowledgeChunk(source=source.name, heading=current_heading, text="\n".join(current_lines).strip())
                )
            current_heading = line.lstrip("#").strip() or source.stem
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        chunks.append(KnowledgeChunk(source=source.name, heading=current_heading, text="\n".join(current_lines).strip()))
    return [chunk for chunk in chunks if chunk.text]


def load_knowledge_chunks(directory: str | Path | None = None) -> list[KnowledgeChunk]:
    """Load all markdown knowledge chunks from data/knowledge."""
    source = Path(directory) if directory else DATA_DIR / "knowledge"
    if not source.exists():
        return []
    chunks: list[KnowledgeChunk] = []
    for path in sorted(source.glob("*.md")):
        chunks.extend(split_markdown(path))
    return chunks


def search_chunks(query: str, chunks: list[KnowledgeChunk], limit: int = 4) -> list[KnowledgeChunk]:
    """Return the most relevant chunks using simple token overlap scoring."""
    query_terms = tokenize(query)
    scored: list[tuple[float, KnowledgeChunk]] = []
    for chunk in chunks:
        haystack = f"{chunk.heading}\n{chunk.text}"
        terms = tokenize(haystack)
        overlap = len(query_terms & terms)
        phrase_bonus = 2 if query.lower() in haystack.lower() else 0
        if overlap or phrase_bonus:
            scored.append((overlap + phrase_bonus + min(len(terms), 200) / 1000, chunk))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [chunk for _, chunk in scored[:limit]]

