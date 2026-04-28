"""RAG-style local baseball knowledge module."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .retriever import KnowledgeChunk, load_knowledge_chunks, search_chunks


@dataclass(frozen=True)
class KnowledgeAnswer:
    """Answer assembled from local markdown chunks."""

    question: str
    answer: str
    sources: list[str]


class BaseballKnowledgeBase:
    """Local markdown knowledge base for sabermetrics and betting concepts."""

    def __init__(self, directory: str | Path | None = None) -> None:
        self.chunks = load_knowledge_chunks(directory)

    def search(self, query: str, limit: int = 4) -> list[KnowledgeChunk]:
        """Retrieve relevant knowledge chunks."""
        return search_chunks(query, self.chunks, limit=limit)

    def answer(self, question: str, limit: int = 3) -> KnowledgeAnswer:
        """Return a compact grounded answer from local knowledge."""
        chunks = self.search(question, limit=limit)
        if not chunks:
            return KnowledgeAnswer(
                question=question,
                answer="Knowledge base belum punya konteks yang cukup untuk pertanyaan itu.",
                sources=[],
            )

        lines = []
        for chunk in chunks:
            compact = " ".join(chunk.text.split())
            lines.append(f"- {chunk.heading}: {compact[:420]}")
        return KnowledgeAnswer(
            question=question,
            answer="\n".join(lines),
            sources=[f"{chunk.source}#{chunk.heading}" for chunk in chunks],
        )


def answer_baseball_question(question: str) -> dict[str, object]:
    """Convenience function for agent tools and tests."""
    answer = BaseballKnowledgeBase().answer(question)
    return {
        "question": answer.question,
        "answer": answer.answer,
        "sources": answer.sources,
    }

