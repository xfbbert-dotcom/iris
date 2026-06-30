from iris_worker.jobs import parse_document_job, summarize_group_job


def test_parse_document_job_returns_chunks_with_source():
    result = parse_document_job(
        document_id="doc-1",
        source="group-visible",
        text="First paragraph.\n\nSecond paragraph.",
    )

    assert result["document_id"] == "doc-1"
    assert result["source"] == "group-visible"
    assert result["chunks"] == ["First paragraph.", "Second paragraph."]


def test_summarize_group_job_returns_evidence_bound_summary():
    result = summarize_group_job(
        group_id="chat-a",
        messages=["Alice: We should publish the FAQ.", "Bob: Confirmed."],
    )

    assert result["group_id"] == "chat-a"
    assert "publish the FAQ" in result["summary"]
    assert result["evidence_count"] == 2
