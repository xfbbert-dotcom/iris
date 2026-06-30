from __future__ import annotations


def parse_document_job(document_id: str, source: str, text: str) -> dict:
    chunks = [chunk.strip() for chunk in text.split("\n\n") if chunk.strip()]
    return {
        "document_id": document_id,
        "source": source,
        "chunks": chunks,
    }


def summarize_group_job(group_id: str, messages: list[str]) -> dict:
    joined = " ".join(messages)
    summary = joined[:240]
    return {
        "group_id": group_id,
        "summary": summary,
        "evidence_count": len(messages),
    }
