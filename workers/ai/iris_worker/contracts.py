from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    field_validator,
    model_validator,
)

MAX_IDENTIFIER_CHARS = 512
MAX_MESSAGE_TEXT_CHARS = 8000
MAX_MEMORY_CONTENT_CHARS = 4000
MAX_MESSAGES = 50
MAX_EVIDENCE_MESSAGE_IDS = 40
MAX_EXISTING_MEMORIES = 8
MAX_CANDIDATES = 8


def _require_exact_identifier(value: str) -> str:
    if value != value.strip():
        raise ValueError("identifier cannot have surrounding whitespace")
    return value


Identifier = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_IDENTIFIER_CHARS),
    AfterValidator(_require_exact_identifier),
]
Timestamp = Annotated[str, StringConstraints(min_length=1, max_length=64)]
MessageText = Annotated[str, StringConstraints(min_length=1, max_length=MAX_MESSAGE_TEXT_CHARS)]
MemoryText = Annotated[str, StringConstraints(min_length=1, max_length=MAX_MEMORY_CONTENT_CHARS)]
Fingerprint = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
Confidence = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False, strict=True)]

CandidateCategory = Literal[
    "project", "preference", "person", "term", "workflow", "decision"
]
ExistingMemoryCategory = Literal[
    "project",
    "preference",
    "person",
    "term",
    "workflow",
    "decision",
    "action",
    "summary",
]
CandidateRelation = Literal["new", "duplicate", "conflict"]


def _require_schema_version(value: object) -> int:
    if type(value) is not int or value != 1:
        raise ValueError("schema_version must be the integer 1")
    return value


SchemaVersion = Annotated[Literal[1], BeforeValidator(_require_schema_version)]


class ExtractionMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Identifier
    sender_id: Identifier | None = None
    sent_at: Timestamp
    text: MessageText

    @field_validator("sent_at")
    @classmethod
    def validate_sent_at(cls, value: str) -> str:
        _require_timezone_timestamp(value)
        return value

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must be nonblank")
        return value


class ExistingMemory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Identifier
    category: ExistingMemoryCategory
    content: MemoryText
    updated_at: Timestamp

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must be nonblank")
        return value

    @field_validator("updated_at")
    @classmethod
    def validate_updated_at(cls, value: str) -> str:
        _require_timezone_timestamp(value)
        return value


class MemoryCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: CandidateCategory
    content: MemoryText
    importance: Annotated[StrictInt, Field(ge=1, le=5)]
    confidence: Confidence
    evidence_message_ids: Annotated[
        list[Identifier], Field(min_length=1, max_length=MAX_EVIDENCE_MESSAGE_IDS)
    ]
    relation: CandidateRelation
    existing_memory_id: Identifier | None = None

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must be nonblank")
        return value

    @field_validator("evidence_message_ids")
    @classmethod
    def validate_unique_evidence_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("evidence_message_ids must be unique")
        return value

    @model_validator(mode="after")
    def validate_relation_reference(self) -> MemoryCandidate:
        if self.relation == "new" and self.existing_memory_id is not None:
            raise ValueError("new candidates cannot name an existing memory")
        if self.relation != "new" and self.existing_memory_id is None:
            raise ValueError("duplicate and conflict candidates require existing_memory_id")
        return self


class MemoryExtractionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: SchemaVersion
    run_id: Identifier
    group_id: Identifier
    input_fingerprint: Fingerprint
    messages: Annotated[list[ExtractionMessage], Field(min_length=1, max_length=MAX_MESSAGES)]
    evidence_message_ids: Annotated[
        list[Identifier], Field(min_length=1, max_length=MAX_EVIDENCE_MESSAGE_IDS)
    ]
    existing_memories: Annotated[
        list[ExistingMemory], Field(max_length=MAX_EXISTING_MEMORIES)
    ]

    @model_validator(mode="after")
    def validate_owned_unique_ids(self) -> MemoryExtractionRequest:
        message_ids = [message.id for message in self.messages]
        if len(message_ids) != len(set(message_ids)):
            raise ValueError("message ids must be unique")
        if len(self.evidence_message_ids) != len(set(self.evidence_message_ids)):
            raise ValueError("evidence_message_ids must be unique")
        if not set(self.evidence_message_ids).issubset(message_ids):
            raise ValueError("evidence_message_ids must identify request messages")
        memory_ids = [memory.id for memory in self.existing_memories]
        if len(memory_ids) != len(set(memory_ids)):
            raise ValueError("existing memory ids must be unique")
        return self


class MemoryExtractionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: SchemaVersion
    run_id: Identifier
    candidates: Annotated[list[MemoryCandidate], Field(max_length=MAX_CANDIDATES)]


def _require_timezone_timestamp(value: str) -> None:
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("timestamp must be ISO 8601") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
