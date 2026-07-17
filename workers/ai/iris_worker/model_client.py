from __future__ import annotations

import asyncio
import json
import re
from typing import Annotated, Literal, Protocol

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    ValidationError,
)

from .config import MAX_MODEL_RESPONSE_BYTES, Settings

ModelErrorCode = Literal[
    "provider_timeout",
    "provider_rate_limited",
    "provider_unavailable",
    "invalid_model_response",
]
_MODEL_ERROR_CODES = {
    "provider_timeout",
    "provider_rate_limited",
    "provider_unavailable",
    "invalid_model_response",
}
_RETRY_AFTER_PATTERN = re.compile(r"^(0|[1-9][0-9]{0,4})$")
_RESPONSE_SCHEMA_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_RETRY_AFTER_SECONDS = 86_400
_MAX_CONTENT_LENGTH_DIGITS = 20


class ModelClient(Protocol):
    async def complete_json_object(
        self,
        *,
        system_instruction: str,
        user_content: str,
        response_schema: dict[str, object] | None = None,
        response_schema_name: str | None = None,
    ) -> str: ...


class ModelClientError(Exception):
    def __init__(
        self, code: ModelErrorCode, *, retry_after_seconds: int | None = None
    ) -> None:
        if code not in _MODEL_ERROR_CODES:
            raise ValueError("invalid model client error code")
        self.code = code
        self.retry_after_seconds = (
            retry_after_seconds if code == "provider_rate_limited" else None
        )
        super().__init__(code)


BoundedProviderString = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_MODEL_RESPONSE_BYTES)
]


class _ProviderMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["assistant"]
    content: BoundedProviderString
    refusal: Annotated[str, StringConstraints(max_length=4096)] | None = None
    # Gemini's OpenAI-compatible endpoint returns its bounded thought signature here.
    extra_content: dict[str, object] | None = None


class _ProviderChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: Annotated[StrictInt, Field(ge=0)]
    message: _ProviderMessage
    finish_reason: Literal["stop"]
    logprobs: None = None


class _PromptTokenDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audio_tokens: Annotated[StrictInt, Field(ge=0)] | None = None
    cached_tokens: Annotated[StrictInt, Field(ge=0)] | None = None


class _CompletionTokenDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted_prediction_tokens: Annotated[StrictInt, Field(ge=0)] | None = None
    audio_tokens: Annotated[StrictInt, Field(ge=0)] | None = None
    reasoning_tokens: Annotated[StrictInt, Field(ge=0)] | None = None
    rejected_prediction_tokens: Annotated[StrictInt, Field(ge=0)] | None = None


class _ProviderUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_tokens: Annotated[StrictInt, Field(ge=0)]
    completion_tokens: Annotated[StrictInt, Field(ge=0)]
    total_tokens: Annotated[StrictInt, Field(ge=0)]
    prompt_tokens_details: _PromptTokenDetails | None = None
    completion_tokens_details: _CompletionTokenDetails | None = None


class _ProviderCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    choices: Annotated[list[_ProviderChoice], Field(min_length=1, max_length=1)]
    id: Annotated[str, StringConstraints(min_length=1, max_length=512)] | None = None
    object: Literal["chat.completion"] | None = None
    created: Annotated[StrictInt, Field(ge=0)] | None = None
    model: Annotated[str, StringConstraints(min_length=1, max_length=512)] | None = None
    usage: _ProviderUsage | None = None
    system_fingerprint: Annotated[str, StringConstraints(max_length=512)] | None = None
    service_tier: Annotated[str, StringConstraints(max_length=128)] | None = None


class OpenAICompatibleModelClient:
    def __init__(
        self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._endpoint = f"{settings.model_base_url}/chat/completions"
        self._api_key = settings.model_api_key
        self._model = settings.model_name
        timeout_seconds = settings.model_timeout_ms / 1000
        self._wall_timeout_seconds = timeout_seconds
        self._timeout = httpx.Timeout(
            connect=timeout_seconds,
            read=timeout_seconds,
            write=timeout_seconds,
            pool=timeout_seconds,
        )
        self._max_response_bytes = settings.model_max_response_bytes
        self._transport = transport

    async def complete_json_object(
        self,
        *,
        system_instruction: str,
        user_content: str,
        response_schema: dict[str, object] | None = None,
        response_schema_name: str | None = None,
    ) -> str:
        _validate_response_schema_options(response_schema, response_schema_name)
        try:
            async with asyncio.timeout(self._wall_timeout_seconds):
                return await self._complete_json_object(
                    system_instruction=system_instruction,
                    user_content=user_content,
                    response_schema=response_schema,
                    response_schema_name=response_schema_name,
                )
        except TimeoutError:
            raise ModelClientError("provider_timeout") from None

    async def _complete_json_object(
        self,
        *,
        system_instruction: str,
        user_content: str,
        response_schema: dict[str, object] | None,
        response_schema_name: str | None,
    ) -> str:
        response_format: dict[str, object]
        if response_schema is None:
            response_format = {"type": "json_object"}
        else:
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": response_schema_name,
                    "strict": True,
                    "schema": response_schema,
                },
            }
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": user_content},
            ],
            "response_format": response_format,
            "temperature": 0,
        }
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                transport=self._transport,
                trust_env=False,
            ) as client:
                request = client.build_request(
                    "POST",
                    self._endpoint,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Accept-Encoding": "identity",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                try:
                    response = await client.send(request, stream=True)
                except ValueError:
                    raise ModelClientError("invalid_model_response") from None
                try:
                    if response.status_code == 429:
                        raise ModelClientError(
                            "provider_rate_limited",
                            retry_after_seconds=_parse_retry_after(
                                response.headers.get("Retry-After")
                            ),
                        )
                    if response.status_code < 200 or response.status_code >= 300:
                        raise ModelClientError("provider_unavailable")
                    _require_identity_content_encoding(response)
                    body = await _read_bounded_body(
                        response, self._max_response_bytes
                    )
                finally:
                    await response.aclose()
        except ModelClientError:
            raise
        except httpx.TimeoutException:
            raise ModelClientError("provider_timeout") from None
        except httpx.RemoteProtocolError:
            raise ModelClientError("invalid_model_response") from None
        except httpx.RequestError:
            raise ModelClientError("provider_unavailable") from None

        return _parse_completion_content(body)


def _validate_response_schema_options(
    response_schema: dict[str, object] | None, response_schema_name: str | None
) -> None:
    if (response_schema is None) != (response_schema_name is None):
        raise ValueError("response schema and name must be supplied together")
    if response_schema_name is not None and _RESPONSE_SCHEMA_NAME_PATTERN.fullmatch(
        response_schema_name
    ) is None:
        raise ValueError("invalid response schema name")


async def _read_bounded_body(response: httpx.Response, limit: int) -> bytes:
    _require_bounded_content_length(response, limit)
    body = bytearray()
    async for chunk in response.aiter_raw():
        if len(body) + len(chunk) > limit:
            raise ModelClientError("invalid_model_response")
        body.extend(chunk)
    return bytes(body)


def _require_bounded_content_length(response: httpx.Response, limit: int) -> None:
    values = response.headers.get_list("Content-Length")
    if not values:
        return
    if len(values) != 1:
        raise ModelClientError("invalid_model_response")

    value = values[0]
    if (
        not 1 <= len(value) <= _MAX_CONTENT_LENGTH_DIGITS
        or not value.isascii()
        or not value.isdigit()
    ):
        raise ModelClientError("invalid_model_response")

    normalized = value.lstrip("0") or "0"
    limit_text = str(limit)
    if len(normalized) > len(limit_text) or (
        len(normalized) == len(limit_text) and normalized > limit_text
    ):
        raise ModelClientError("invalid_model_response")


def _require_identity_content_encoding(response: httpx.Response) -> None:
    content_encoding = response.headers.get("Content-Encoding")
    if content_encoding is not None and content_encoding.strip().lower() not in {
        "",
        "identity",
    }:
        raise ModelClientError("invalid_model_response")


def _parse_completion_content(body: bytes) -> str:
    try:
        raw = json.loads(body, parse_constant=_reject_nonfinite_json)
        completion = _ProviderCompletion.model_validate(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError, TypeError):
        raise ModelClientError("invalid_model_response") from None
    content = completion.choices[0].message.content
    if not content.strip():
        raise ModelClientError("invalid_model_response")
    return content


def _parse_retry_after(value: str | None) -> int | None:
    if value is None or _RETRY_AFTER_PATTERN.fullmatch(value) is None:
        return None
    seconds = int(value, 10)
    if seconds > _MAX_RETRY_AFTER_SECONDS:
        return None
    return max(60, seconds)


def _reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"invalid JSON numeric constant: {value}")
