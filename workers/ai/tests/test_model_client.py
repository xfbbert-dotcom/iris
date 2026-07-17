import asyncio
import gzip
import json

import httpx
import pytest


class TrackingStream(httpx.AsyncByteStream):
    def __init__(self, content: bytes):
        self.content = content
        self.iterated = False

    async def __aiter__(self):
        self.iterated = True
        yield self.content


class SlowEndlessStream(httpx.AsyncByteStream):
    def __init__(self):
        self.chunks_yielded = 0

    async def __aiter__(self):
        while True:
            await asyncio.sleep(0.02)
            self.chunks_yielded += 1
            yield b"x"


def streaming_json_response(payload: object) -> httpx.Response:
    body = json.dumps(payload, separators=(",", ":")).encode()
    return httpx.Response(
        200,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
        stream=TrackingStream(body),
    )


def settings(
    *,
    base_url: str = "https://model.example/v1",
    max_response_bytes: int = 4096,
    timeout_ms: int = 4321,
):
    from iris_worker.config import Settings

    return Settings.from_env(
        {
            "IRIS_AI_WORKER_TOKEN": "internal-worker-token",
            "IRIS_MODEL_BASE_URL": base_url,
            "IRIS_MODEL_API_KEY": "model-api-key",
            "IRIS_MODEL_NAME": "extractor-model",
            "IRIS_MODEL_TIMEOUT_MS": str(timeout_ms),
            "IRIS_MODEL_MAX_RESPONSE_BYTES": str(max_response_bytes),
        }
    )


def completion_response(content: str) -> dict[str, object]:
    return {
        "id": "completion-1",
        "object": "chat.completion",
        "created": 1,
        "model": "extractor-model",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
                "logprobs": None,
            }
        ],
        "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 8,
            "total_tokens": 20,
        },
    }


def client_for(
    handler, *, max_response_bytes: int = 4096, timeout_ms: int = 4321
):
    from iris_worker.model_client import OpenAICompatibleModelClient

    return OpenAICompatibleModelClient(
        settings(max_response_bytes=max_response_bytes, timeout_ms=timeout_ms),
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_calls_chat_completions_with_json_object_mode_and_explicit_timeouts():
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        captured["payload"] = json.loads(request.content)
        return streaming_json_response(completion_response('{"schema_version":1}'))

    client = client_for(handler)
    result = await client.complete_json_object(
        system_instruction="trusted instruction",
        user_content="untrusted data",
    )

    request = captured["request"]
    assert isinstance(request, httpx.Request)
    assert request.url == httpx.URL("https://model.example/v1/chat/completions")
    assert request.headers["authorization"] == "Bearer model-api-key"
    assert request.headers["accept-encoding"] == "identity"
    assert request.extensions["timeout"] == {
        "connect": 4.321,
        "read": 4.321,
        "write": 4.321,
        "pool": 4.321,
    }
    assert captured["payload"] == {
        "model": "extractor-model",
        "messages": [
            {"role": "system", "content": "trusted instruction"},
            {"role": "user", "content": "untrusted data"},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }
    assert result == '{"schema_version":1}'


@pytest.mark.asyncio
async def test_accepts_gemini_extra_content_without_relaxing_other_message_fields():
    provider_response = completion_response('{"schema_version":2}')
    message = provider_response["choices"][0]["message"]
    message["extra_content"] = {
        "google": {"thought_signature": "bounded-provider-metadata"}
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        return streaming_json_response(provider_response)

    result = await client_for(handler).complete_json_object(
        system_instruction="trusted instruction",
        user_content="untrusted data",
    )

    assert result == '{"schema_version":2}'


@pytest.mark.asyncio
async def test_calls_chat_completions_with_explicit_json_schema_mode():
    captured: dict[str, object] = {}
    response_schema = {
        "type": "object",
        "properties": {"schema_version": {"type": "integer", "enum": [2]}},
        "required": ["schema_version"],
        "additionalProperties": False,
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content)
        return streaming_json_response(completion_response('{"schema_version":2}'))

    result = await client_for(handler).complete_json_object(
        system_instruction="trusted instruction",
        user_content="untrusted data",
        response_schema=response_schema,
        response_schema_name="iris_memory_extraction_v2",
    )

    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["response_format"] == {
        "type": "json_schema",
        "json_schema": {
            "name": "iris_memory_extraction_v2",
            "strict": True,
            "schema": response_schema,
        },
    }
    assert result == '{"schema_version":2}'


@pytest.mark.asyncio
async def test_accepts_large_structured_content_within_configured_byte_budget():
    content = json.dumps({"candidates": [{"content": "x" * 5000}]})

    async def handler(request: httpx.Request) -> httpx.Response:
        return streaming_json_response(completion_response(content))

    result = await client_for(handler, max_response_bytes=65_536).complete_json_object(
        system_instruction="trusted instruction",
        user_content="untrusted data",
    )

    assert result == content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error_type", "expected_code"),
    [
        (httpx.ConnectTimeout, "provider_timeout"),
        (httpx.ReadTimeout, "provider_timeout"),
        (httpx.ConnectError, "provider_unavailable"),
        (httpx.RemoteProtocolError, "invalid_model_response"),
    ],
)
async def test_maps_transport_failures_without_exception_details(error_type, expected_code):
    from iris_worker.model_client import ModelClientError

    async def handler(request: httpx.Request) -> httpx.Response:
        raise error_type("provider-url-and-secret-details", request=request)

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == expected_code
    assert str(caught.value) == expected_code
    assert caught.value.retry_after_seconds is None
    assert "secret" not in repr(caught.value)


@pytest.mark.asyncio
async def test_maps_rate_limit_and_preserves_only_valid_retry_after():
    from iris_worker.model_client import ModelClientError

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"Retry-After": "120"},
            text="provider body secret",
        )

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == "provider_rate_limited"
    assert caught.value.retry_after_seconds == 120
    assert str(caught.value) == "provider_rate_limited"
    assert "provider body" not in repr(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected_code", "expected_retry_after"),
    [
        (429, "provider_rate_limited", 120),
        (503, "provider_unavailable", None),
    ],
)
async def test_maps_encoded_error_status_without_reading_provider_body(
    status: int,
    expected_code: str,
    expected_retry_after: int | None,
):
    from iris_worker.model_client import ModelClientError

    stream = TrackingStream(gzip.compress(b"provider-body-secret" * 1000))

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            headers={"Content-Encoding": "gzip", "Retry-After": "120"},
            stream=stream,
        )

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == expected_code
    assert caught.value.retry_after_seconds == expected_retry_after
    assert str(caught.value) == expected_code
    assert "secret" not in repr(caught.value)
    assert stream.iterated is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("0", 60),
        ("59", 60),
        ("86400", 86400),
        ("86401", None),
        ("+120", None),
        ("120.0", None),
        ("Wed, 21 Oct 2015 07:28:00 GMT", None),
    ],
)
async def test_retry_after_must_be_a_safe_bounded_integer(header: str, expected: int | None):
    from iris_worker.model_client import ModelClientError

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": header})

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="instruction",
            user_content="data",
        )

    assert caught.value.retry_after_seconds == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403, 500, 502, 503])
async def test_maps_non_success_provider_status_without_response_body(status: int):
    from iris_worker.model_client import ModelClientError

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="provider-body-secret")

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == "provider_unavailable"
    assert str(caught.value) == "provider_unavailable"
    assert "secret" not in repr(caught.value)


@pytest.mark.asyncio
async def test_rejects_response_over_byte_budget_without_exposing_body():
    from iris_worker.model_client import ModelClientError

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=TrackingStream(b"x" * 4097))

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == "invalid_model_response"
    assert str(caught.value) == "invalid_model_response"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        [("Content-Length", "9" * 5000)],
        [("Content-Length", "4097")],
        [("Content-Length", "1"), ("Content-Length", "1")],
        [("Content-Length", "1,1")],
        [("Content-Length", "+1")],
        [("Content-Length", "-1")],
        [("Content-Length", " 1")],
        [("Content-Length", "1 ")],
        [("Content-Length", "")],
        [(b"Content-Length", b"\xff")],
    ],
    ids=[
        "five-thousand-digits",
        "over-byte-budget",
        "duplicate",
        "comma",
        "signed-positive",
        "signed-negative",
        "leading-whitespace",
        "trailing-whitespace",
        "empty",
        "non-ascii-decimal",
    ],
)
async def test_rejects_untrusted_content_length_without_reading_body(
    headers: list[tuple[str | bytes, str | bytes]],
):
    from iris_worker.model_client import ModelClientError

    stream = TrackingStream(
        json.dumps(completion_response('{"schema_version":1}')).encode()
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=headers, stream=stream)

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == "invalid_model_response"
    assert str(caught.value) == "invalid_model_response"
    assert "secret" not in repr(caught.value)
    assert stream.iterated is False


@pytest.mark.asyncio
async def test_real_http_protocol_rejects_extreme_content_length_without_raw_error():
    from iris_worker.model_client import ModelClientError, OpenAICompatibleModelClient

    response_sent = asyncio.Event()

    async def handle_connection(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            await reader.readuntil(b"\r\n\r\n")
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: "
                + (b"9" * 5000)
                + b"\r\n\r\nprovider-body-secret"
            )
            await writer.drain()
        finally:
            response_sent.set()
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    server = await asyncio.start_server(handle_connection, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    # Keep this protocol assertion independent of Windows event-loop scheduling latency.
    client = OpenAICompatibleModelClient(
        settings(base_url=f"http://127.0.0.1:{port}", timeout_ms=5000)
    )

    try:
        with pytest.raises(ModelClientError) as caught:
            await client.complete_json_object(
                system_instruction="prompt-secret",
                user_content="message-secret",
            )
        await asyncio.wait_for(response_sent.wait(), timeout=1)
    finally:
        server.close()
        await server.wait_closed()

    assert caught.value.code == "invalid_model_response"
    assert str(caught.value) == "invalid_model_response"
    assert "secret" not in repr(caught.value)


@pytest.mark.asyncio
async def test_rejects_gzip_response_before_streaming_or_decoding_it():
    from iris_worker.model_client import ModelClientError

    stream = TrackingStream(gzip.compress(b"decompressed-secret" * 200_000))

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Encoding": "gzip"},
            stream=stream,
        )

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == "invalid_model_response"
    assert str(caught.value) == "invalid_model_response"
    assert "secret" not in repr(caught.value)
    assert stream.iterated is False


@pytest.mark.asyncio
async def test_total_wall_clock_deadline_stops_endless_slow_response():
    from iris_worker.model_client import ModelClientError

    stream = SlowEndlessStream()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    with pytest.raises(ModelClientError) as caught:
        await asyncio.wait_for(
            client_for(handler, timeout_ms=80).complete_json_object(
                system_instruction="prompt-secret",
                user_content="message-secret",
            ),
            timeout=0.5,
        )

    assert caught.value.code == "provider_timeout"
    assert str(caught.value) == "provider_timeout"
    assert "secret" not in repr(caught.value)
    assert stream.chunks_yielded >= 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        b"not-json",
        json.dumps({"choices": []}).encode(),
        json.dumps(
            {
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "  "},
                        "finish_reason": "stop",
                        "logprobs": None,
                    }
                ]
            }
        ).encode(),
        json.dumps(
            {
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "{}",
                            "unexpected": "field",
                        },
                        "finish_reason": "stop",
                        "logprobs": None,
                    }
                ]
            }
        ).encode(),
    ],
)
async def test_strictly_rejects_malformed_or_blank_provider_envelopes(body: bytes):
    from iris_worker.model_client import ModelClientError

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=TrackingStream(body))

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="instruction",
            user_content="data",
        )

    assert caught.value.code == "invalid_model_response"
