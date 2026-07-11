from __future__ import annotations

import re
from typing import TypedDict


class ParseDocumentResult(TypedDict):
    document_id: str
    source: str
    chunks: list[str]


class SummarizeGroupResult(TypedDict):
    group_id: str
    summary: str
    evidence_count: int


def parse_document_job(
    document_id: str,
    source: str,
    text: str,
) -> ParseDocumentResult:
    chunks = [
        chunk.strip()
        for chunk in re.split(r"(?:\r?\n)[ \t]*(?:\r?\n)+", text)
        if chunk.strip()
    ]
    return {
        "document_id": document_id,
        "source": source,
        "chunks": chunks,
    }


def summarize_group_job(
    group_id: str,
    messages: list[str],
) -> SummarizeGroupResult:
    joined = " ".join(messages)
    summary = joined[:240]
    return {
        "group_id": group_id,
        "summary": summary,
        "evidence_count": len(messages),
    }
