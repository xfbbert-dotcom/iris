from __future__ import annotations

import secrets
from typing import Any, Awaitable, Callable, Protocol

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from .config import Settings
from .contracts import (
    ActionCorrectOperation,
    MemoryExtractionRequest,
    MemoryExtractionRequestV2,
    MemoryExtractionResponse,
    MemoryExtractionResponseV2,
)
from .memory_extraction import MemoryExtractionService
from .model_client import ModelClientError, OpenAICompatibleModelClient

MAX_EXTRACTION_REQUEST_BYTES = 512 * 1024

ASGIReceive = Callable[[], Awaitable[dict[str, Any]]]
ASGISend = Callable[[dict[str, Any]], Awaitable[None]]


class ExtractionService(Protocol):
    async def extract(
        self, request: MemoryExtractionRequest | MemoryExtractionRequestV2
    ) -> MemoryExtractionResponse | MemoryExtractionResponseV2: ...


class _ExtractionBoundaryMiddleware:
    def __init__(self, app: Any, *, token: str) -> None:
        self._app = app
        self._expected_authorization = f"Bearer {token}".encode("ascii")

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: ASGIReceive,
        send: ASGISend,
    ) -> None:
        if not _is_extraction_request(scope):
            await self._app(scope, receive, send)
            return

        authorization_values = [
            value for name, value in scope.get("headers", []) if name == b"authorization"
        ]
        if len(authorization_values) != 1 or not secrets.compare_digest(
            authorization_values[0], self._expected_authorization
        ):
            await _send_empty_response(
                send, 401, headers=[(b"www-authenticate", b"Bearer")]
            )
            return

        content_lengths = [
            value for name, value in scope.get("headers", []) if name == b"content-length"
        ]
        if len(content_lengths) == 1 and content_lengths[0].isdigit():
            if int(content_lengths[0], 10) > MAX_EXTRACTION_REQUEST_BYTES:
                await _send_empty_response(send, 413)
                return

        body = bytearray()
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_EXTRACTION_REQUEST_BYTES:
                await _send_empty_response(send, 413)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        sent = False

        async def buffered_receive() -> dict[str, Any]:
            nonlocal sent
            if sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            sent = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self._app(scope, buffered_receive, send)


def create_app(
    settings: Settings, *, extraction_service: ExtractionService | None = None
) -> FastAPI:
    service = extraction_service or MemoryExtractionService(
        OpenAICompatibleModelClient(settings)
    )
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    app.add_middleware(_ExtractionBoundaryMiddleware, token=settings.internal_token)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: object, _error: RequestValidationError
    ) -> Response:
        return Response(status_code=422)

    @app.exception_handler(ModelClientError)
    async def model_error_handler(_request: object, error: ModelClientError) -> Response:
        statuses = {
            "provider_timeout": 504,
            "provider_rate_limited": 429,
            "provider_unavailable": 503,
            "invalid_model_response": 502,
        }
        body: dict[str, object] = {"error": error.code}
        headers: dict[str, str] = {}
        if (
            error.code == "provider_rate_limited"
            and error.retry_after_seconds is not None
        ):
            body["retry_after_seconds"] = error.retry_after_seconds
            headers["Retry-After"] = str(error.retry_after_seconds)
        return JSONResponse(body, status_code=statuses[error.code], headers=headers)

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "service": "iris-ai-worker", "schemaVersion": 1}

    @app.post(
        "/v1/memory/extract",
        response_model=MemoryExtractionResponse | MemoryExtractionResponseV2,
        response_model_exclude_none=True,
    )
    async def extract(
        request: MemoryExtractionRequest | MemoryExtractionRequestV2,
    ) -> Response:
        return JSONResponse(
            _serialize_extraction_response(await service.extract(request))
        )

    return app


def _serialize_extraction_response(
    response: MemoryExtractionResponse | MemoryExtractionResponseV2,
) -> dict[str, object]:
    serialized = response.model_dump(mode="json", exclude_none=True)
    if not isinstance(response, MemoryExtractionResponseV2):
        return serialized

    action_operations = serialized["action_operations"]
    assert isinstance(action_operations, list)
    for serialized_operation, operation in zip(
        action_operations, response.action_operations, strict=True
    ):
        if (
            isinstance(operation, ActionCorrectOperation)
            and "thread_id" in operation.model_fields_set
            and operation.thread_id is None
        ):
            assert isinstance(serialized_operation, dict)
            serialized_operation["thread_id"] = None
    return serialized


def _is_extraction_request(scope: dict[str, Any]) -> bool:
    return (
        scope.get("type") == "http"
        and scope.get("method") == "POST"
        and scope.get("path") == "/v1/memory/extract"
    )


async def _send_empty_response(
    send: ASGISend,
    status: int,
    *,
    headers: list[tuple[bytes, bytes]] | None = None,
) -> None:
    response_headers = [(b"content-length", b"0")]
    response_headers.extend(headers or [])
    await send(
        {"type": "http.response.start", "status": status, "headers": response_headers}
    )
    await send({"type": "http.response.body", "body": b""})
