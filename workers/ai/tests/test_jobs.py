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


def test_parse_document_job_splits_crlf_paragraphs():
    result = parse_document_job(
        document_id="doc-1",
        source="group-visible",
        text="First paragraph.\r\n\r\nSecond paragraph.",
    )

    assert result["chunks"] == ["First paragraph.", "Second paragraph."]


def test_parse_document_job_splits_blank_lines_with_whitespace():
    result = parse_document_job(
        document_id="doc-1",
        source="group-visible",
        text="First paragraph.\n  \t\nSecond paragraph.",
    )

    assert result["chunks"] == ["First paragraph.", "Second paragraph."]


def test_parse_document_job_empty_text_returns_empty_chunks():
    result = parse_document_job(
        document_id="doc-1",
        source="group-visible",
        text=" \n\t\n ",
    )

    assert result["chunks"] == []


def test_summarize_group_job_returns_evidence_bound_summary():
    result = summarize_group_job(
        group_id="chat-a",
        messages=["Alice: We should publish the FAQ.", "Bob: Confirmed."],
    )

    assert result["group_id"] == "chat-a"
    assert "publish the FAQ" in result["summary"]
    assert result["evidence_count"] == 2


def test_summarize_group_job_caps_summary_at_240_characters():
    result = summarize_group_job(
        group_id="chat-a",
        messages=["A" * 300],
    )

    assert len(result["summary"]) == 240


def test_summarize_group_job_counts_blank_message_entries_as_evidence():
    result = summarize_group_job(
        group_id="chat-a",
        messages=["Alice: Confirmed.", "", " \t"],
    )

    # Foundation behavior: evidence_count reflects entries received, including blanks.
    assert result["evidence_count"] == 3
