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
MAX_EXISTING_THREADS = 12
MAX_EXISTING_ACTIONS = 12
MAX_OPERATIONS_PER_FAMILY = 8
MAX_MENTIONS_PER_MESSAGE = 20


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


def _require_schema_version_v2(value: object) -> int:
    if type(value) is not int or value != 2:
        raise ValueError("schema_version must be the integer 2")
    return value


SchemaVersionV2 = Annotated[Literal[2], BeforeValidator(_require_schema_version_v2)]


class ExtractionMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Identifier
    sender_id: Identifier | None = None
    sent_at: Timestamp
    text: MessageText

    @field_validator("sent_at")
    @classmethod
    def validate_sent_at(cls, value: str) -> str:
        _parse_timezone_timestamp(value)
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
        _parse_timezone_timestamp(value)
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
        sent_times = [
            _parse_timezone_timestamp(message.sent_at) for message in self.messages
        ]
        if any(current < previous for previous, current in zip(sent_times, sent_times[1:])):
            raise ValueError("messages must be in nondecreasing chronological order")
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


class ExtractionMention(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: Identifier
    open_id: Identifier


class ExtractionMessageV2(ExtractionMessage):
    mentions: Annotated[list[ExtractionMention], Field(max_length=MAX_MENTIONS_PER_MESSAGE)]

    @field_validator("mentions")
    @classmethod
    def validate_unique_mention_keys(
        cls, value: list[ExtractionMention]
    ) -> list[ExtractionMention]:
        keys = [mention.key for mention in value]
        if len(keys) != len(set(keys)):
            raise ValueError("mention keys must be unique per message")
        return value


class ExistingThread(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Identifier
    title: MemoryText
    summary: MemoryText
    status: Literal["candidate", "open", "resolved"]
    version: Annotated[StrictInt, Field(ge=1)]
    updated_at: Timestamp

    @field_validator("title", "summary")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must be nonblank")
        return value

    @field_validator("updated_at")
    @classmethod
    def validate_updated_at(cls, value: str) -> str:
        _parse_timezone_timestamp(value)
        return value


class ExistingAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Identifier
    thread_id: Identifier | None = None
    description: MemoryText
    owner_ref_type: Literal["feishu_user", "text_label"]
    owner_ref: Identifier
    status: Literal["open", "completed", "cancelled"]
    version: Annotated[StrictInt, Field(ge=1)]
    updated_at: Timestamp

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("description must be nonblank")
        return value

    @field_validator("updated_at")
    @classmethod
    def validate_updated_at(cls, value: str) -> str:
        _parse_timezone_timestamp(value)
        return value


EnabledOperationFamily = Literal["memory", "thread", "action"]


class MemoryExtractionRequestV2(MemoryExtractionRequest):
    schema_version: SchemaVersionV2
    messages: Annotated[
        list[ExtractionMessageV2], Field(min_length=1, max_length=MAX_MESSAGES)
    ]
    existing_threads: Annotated[list[ExistingThread], Field(max_length=MAX_EXISTING_THREADS)]
    existing_actions: Annotated[list[ExistingAction], Field(max_length=MAX_EXISTING_ACTIONS)]
    enabled_operation_families: Annotated[
        list[EnabledOperationFamily], Field(max_length=3)
    ]

    @model_validator(mode="after")
    def validate_v2_context_ids(self) -> MemoryExtractionRequestV2:
        thread_ids = [thread.id for thread in self.existing_threads]
        if len(thread_ids) != len(set(thread_ids)):
            raise ValueError("existing thread ids must be unique")
        action_ids = [action.id for action in self.existing_actions]
        if len(action_ids) != len(set(action_ids)):
            raise ValueError("existing action ids must be unique")
        if len(self.enabled_operation_families) != len(
            set(self.enabled_operation_families)
        ):
            raise ValueError("enabled operation families must be unique")
        return self


class SenderOwnerCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner_type: Literal["sender"]
    message_id: Identifier


class MentionOwnerCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner_type: Literal["mention"]
    message_id: Identifier
    mention_key: Identifier


class TextLabelOwnerCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner_type: Literal["text_label"]
    label: MemoryText

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("label must be nonblank")
        return value


ActionOwnerCandidate = Annotated[
    SenderOwnerCandidate | MentionOwnerCandidate | TextLabelOwnerCandidate,
    Field(discriminator="owner_type"),
]


class EvidenceBoundOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_key: Identifier
    confidence: Confidence
    evidence_message_ids: Annotated[
        list[Identifier], Field(min_length=1, max_length=MAX_EVIDENCE_MESSAGE_IDS)
    ]
    evidence_span: MemoryText

    @field_validator("evidence_span")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must be nonblank")
        return value

    @field_validator("evidence_message_ids")
    @classmethod
    def validate_unique_evidence_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("evidence_message_ids must be unique")
        return value


ExpectedVersion = Annotated[StrictInt, Field(ge=1)]


class ThreadCreateOperation(EvidenceBoundOperation):
    operation: Literal["create"]
    title: MemoryText
    summary: MemoryText
    initial_status: Literal["candidate", "open"]

    @field_validator("title", "summary")
    @classmethod
    def validate_nonblank_thread_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("thread text must be nonblank")
        return value


class ThreadAttachEvidenceOperation(EvidenceBoundOperation):
    operation: Literal["attach_evidence"]
    thread_id: Identifier
    expected_version: ExpectedVersion


class ThreadPromoteOperation(EvidenceBoundOperation):
    operation: Literal["promote"]
    thread_id: Identifier
    expected_version: ExpectedVersion
    summary: MemoryText

    @field_validator("summary")
    @classmethod
    def validate_nonblank_summary(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("summary must be nonblank")
        return value


class ThreadMergeOperation(EvidenceBoundOperation):
    operation: Literal["merge"]
    source_thread_id: Identifier
    target_thread_id: Identifier
    expected_version: ExpectedVersion

    @model_validator(mode="after")
    def validate_distinct_threads(self) -> ThreadMergeOperation:
        if self.source_thread_id == self.target_thread_id:
            raise ValueError("merge source and target must differ")
        return self


class ThreadResolveOperation(EvidenceBoundOperation):
    operation: Literal["resolve"]
    thread_id: Identifier
    expected_version: ExpectedVersion


class ThreadReopenOperation(EvidenceBoundOperation):
    operation: Literal["reopen"]
    thread_id: Identifier
    expected_version: ExpectedVersion


class ThreadUpdateSummaryOperation(EvidenceBoundOperation):
    operation: Literal["update_summary"]
    thread_id: Identifier
    expected_version: ExpectedVersion
    summary: MemoryText

    @field_validator("summary")
    @classmethod
    def validate_nonblank_summary(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("summary must be nonblank")
        return value


class ThreadCorrectOperation(EvidenceBoundOperation):
    operation: Literal["correct"]
    thread_id: Identifier
    expected_version: ExpectedVersion
    corrected_fields: Annotated[
        list[Literal["title", "summary"]], Field(min_length=1, max_length=2)
    ]
    title: MemoryText | None = None
    summary: MemoryText | None = None

    @model_validator(mode="after")
    def validate_corrected_fields(self) -> ThreadCorrectOperation:
        if len(self.corrected_fields) != len(set(self.corrected_fields)):
            raise ValueError("corrected fields must be unique")
        supplied = {
            name
            for name, value in (("title", self.title), ("summary", self.summary))
            if value is not None and value.strip()
        }
        if supplied != set(self.corrected_fields):
            raise ValueError("corrected fields must exactly match supplied values")
        return self


ThreadOperation = Annotated[
    ThreadCreateOperation
    | ThreadAttachEvidenceOperation
    | ThreadPromoteOperation
    | ThreadMergeOperation
    | ThreadResolveOperation
    | ThreadReopenOperation
    | ThreadUpdateSummaryOperation
    | ThreadCorrectOperation,
    Field(discriminator="operation"),
]


class ActionCreateOperation(EvidenceBoundOperation):
    operation: Literal["create"]
    thread_id: Identifier | None = None
    description: MemoryText
    owner: ActionOwnerCandidate
    due_at: Timestamp | None = None
    due_evidence_span: MemoryText | None = None

    @field_validator("description")
    @classmethod
    def validate_nonblank_description(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("description must be nonblank")
        return value

    @field_validator("due_at")
    @classmethod
    def validate_due_at(cls, value: str | None) -> str | None:
        if value is not None:
            _parse_timezone_timestamp(value)
        return value

    @model_validator(mode="after")
    def validate_due_evidence(self) -> ActionCreateOperation:
        if self.due_at is None and self.due_evidence_span is not None:
            raise ValueError("due evidence requires due_at")
        if self.due_at is not None and (
            self.due_evidence_span is None or not self.due_evidence_span.strip()
        ):
            raise ValueError("due_at requires nonblank due_evidence_span")
        return self


class ExistingActionOperation(EvidenceBoundOperation):
    action_id: Identifier
    expected_version: ExpectedVersion


class ActionCompleteOperation(ExistingActionOperation):
    operation: Literal["complete"]


class ActionCancelOperation(ExistingActionOperation):
    operation: Literal["cancel"]


class ActionReopenOperation(ExistingActionOperation):
    operation: Literal["reopen"]


class ActionResolveOwnerOperation(ExistingActionOperation):
    operation: Literal["resolve_owner"]
    owner: ActionOwnerCandidate


class ActionCorrectOperation(ExistingActionOperation):
    operation: Literal["correct"]
    corrected_fields: Annotated[
        list[Literal["description", "thread_id", "owner"]], Field(min_length=1, max_length=3)
    ]
    description: MemoryText | None = None
    thread_id: Identifier | None = None
    owner: ActionOwnerCandidate | None = None

    @model_validator(mode="after")
    def validate_corrected_fields(self) -> ActionCorrectOperation:
        if len(self.corrected_fields) != len(set(self.corrected_fields)):
            raise ValueError("corrected fields must be unique")
        supplied = {
            name
            for name, value in (
                ("description", self.description),
                ("thread_id", self.thread_id),
                ("owner", self.owner),
            )
            if value is not None and (not isinstance(value, str) or value.strip())
        }
        if supplied != set(self.corrected_fields):
            raise ValueError("corrected fields must exactly match supplied values")
        return self


ActionOperation = Annotated[
    ActionCreateOperation
    | ActionCompleteOperation
    | ActionCancelOperation
    | ActionReopenOperation
    | ActionResolveOwnerOperation
    | ActionCorrectOperation,
    Field(discriminator="operation"),
]


class MemoryExtractionResponseV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: SchemaVersionV2
    run_id: Identifier
    candidates: Annotated[list[MemoryCandidate], Field(max_length=MAX_CANDIDATES)]
    thread_operations: Annotated[
        list[ThreadOperation], Field(max_length=MAX_OPERATIONS_PER_FAMILY)
    ]
    action_operations: Annotated[
        list[ActionOperation], Field(max_length=MAX_OPERATIONS_PER_FAMILY)
    ]


def _parse_timezone_timestamp(value: str) -> datetime:
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("timestamp must be ISO 8601") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return parsed
