import json

import httpx
import pytest


def settings(*, max_response_bytes: int = 4096):
    from iris_worker.config import Settings

    return Settings.from_env(
        {
            "IRIS_AI_WORKER_TOKEN": "internal-worker-token",
            "IRIS_MODEL_BASE_URL": "https://model.example/v1",
            "IRIS_MODEL_API_KEY": "model-api-key",
            "IRIS_MODEL_NAME": "extractor-model",
            "IRIS_MODEL_TIMEOUT_MS": "4321",
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


def client_for(handler, *, max_response_bytes: int = 4096):
    from iris_worker.model_client import OpenAICompatibleModelClient

    return OpenAICompatibleModelClient(
        settings(max_response_bytes=max_response_bytes),
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_calls_chat_completions_with_json_object_mode_and_explicit_timeouts():
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json=completion_response('{"schema_version":1}'))

    client = client_for(handler)
    result = await client.complete_json_object(
        system_instruction="trusted instruction",
        user_content="untrusted data",
    )

    request = captured["request"]
    assert isinstance(request, httpx.Request)
    assert request.url == httpx.URL("https://model.example/v1/chat/completions")
    assert request.headers["authorization"] == "Bearer model-api-key"
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
async def test_accepts_large_structured_content_within_configured_byte_budget():
    content = json.dumps({"candidates": [{"content": "x" * 5000}]})

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=completion_response(content))

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
        return httpx.Response(200, content=b"x" * 4097)

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="prompt-secret",
            user_content="message-secret",
        )

    assert caught.value.code == "invalid_model_response"
    assert str(caught.value) == "invalid_model_response"


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
        return httpx.Response(200, content=body)

    with pytest.raises(ModelClientError) as caught:
        await client_for(handler).complete_json_object(
            system_instruction="instruction",
            user_content="data",
        )

    assert caught.value.code == "invalid_model_response"
