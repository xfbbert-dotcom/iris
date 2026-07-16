import json
from pathlib import Path

import pytest


INVALID_MODEL_RESPONSE_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "invalid_model_response.json").read_text(
        encoding="utf-8"
    )
)


def valid_request(**overrides: object) -> dict[str, object]:
    request: dict[str, object] = {
        "schema_version": 1,
        "run_id": "run-1",
        "group_id": "group-1",
        "input_fingerprint": "a" * 64,
        "messages": [
            {
                "id": "message-1",
                "sender_id": "sender-1",
                "sent_at": "2026-07-14T00:00:00.000Z",
                "text": "Launch is Thursday.",
            }
        ],
        "evidence_message_ids": ["message-1"],
        "existing_memories": [],
    }
    request.update(overrides)
    return request


def valid_response():
    from iris_worker.contracts import MemoryExtractionResponse

    return MemoryExtractionResponse.model_validate(
        {"schema_version": 1, "run_id": "run-1", "candidates": []}
    )


def valid_v2_request() -> dict[str, object]:
    return {
        "schema_version": 2,
        "run_id": "run-2",
        "group_id": "group-1",
        "input_fingerprint": "b" * 64,
        "messages": [
            {
                "id": "message-1",
                "sender_open_id": "sender-1",
                "sent_at": "2026-07-14T00:00:00.000Z",
                "text": "I will ship the API.",
                "mentions": [],
            }
        ],
        "evidence_message_ids": ["message-1"],
        "existing_memories": [],
        "existing_threads": [],
        "existing_actions": [],
        "enabled_operation_families": ["memory", "thread", "action"],
    }


def valid_v2_response():
    from iris_worker.contracts import MemoryExtractionResponseV2

    return MemoryExtractionResponseV2.model_validate(
        {
            "schema_version": 2,
            "run_id": "run-2",
            "candidates": [],
            "thread_operations": [],
            "action_operations": [],
        }
    )


def settings():
    from iris_worker.config import Settings

    return Settings.from_env(
        {
            "IRIS_AI_WORKER_TOKEN": "exact-internal-token",
            "IRIS_MODEL_BASE_URL": "https://model.example/v1",
            "IRIS_MODEL_API_KEY": "model-api-key",
            "IRIS_MODEL_NAME": "extractor-model",
        }
    )


class FakeService:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[object] = []

    async def extract(self, request):
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return self.result


def make_test_client(service: FakeService):
    from fastapi.testclient import TestClient

    return TestClient(make_test_app(service))


def make_test_app(service: FakeService):
    from iris_worker.api import create_app

    return create_app(settings(), extraction_service=service)


def test_exposes_only_exact_health_and_extraction_routes():
    service = FakeService(valid_response())
    app = make_test_app(service)

    routes = {
        (route.path, frozenset(route.methods or set()))
        for route in app.routes
    }

    assert routes == {
        ("/health", frozenset({"GET"})),
        ("/v1/memory/extract", frozenset({"POST"})),
    }


@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
def test_schema_and_documentation_routes_are_not_exposed(path: str):
    service = FakeService(valid_response())

    with make_test_client(service) as client:
        response = client.get(path)

    assert response.status_code == 404


def test_health_is_bounded_and_does_not_call_provider_service():
    service = FakeService(error=AssertionError("health called extraction provider"))
    with make_test_client(service) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "service": "iris-ai-worker",
        "schemaVersion": 1,
    }
    assert service.calls == []


@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "",
        "Bearer",
        "Bearer wrong-token",
        "bearer exact-internal-token",
        "Bearer  exact-internal-token",
        "Bearer exact-internal-token ",
        "Basic exact-internal-token",
    ],
)
def test_extract_requires_exact_bearer_token_before_reading_body(
    authorization: str | None,
):
    service = FakeService(valid_response())
    headers = {} if authorization is None else {"Authorization": authorization}

    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            content=b"not-json-and-must-not-be-parsed",
            headers=headers,
        )

    assert response.status_code == 401
    assert response.content == b""
    assert response.headers["www-authenticate"] == "Bearer"
    assert service.calls == []


def test_extract_accepts_valid_authenticated_request():
    service = FakeService(valid_response())
    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            json=valid_request(),
            headers={"Authorization": "Bearer exact-internal-token"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 1,
        "run_id": "run-1",
        "candidates": [],
    }
    assert len(service.calls) == 1


def test_extract_accepts_schema_v2_without_regressing_v1_route():
    service = FakeService(valid_v2_response())
    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            json=valid_v2_request(),
            headers={"Authorization": "Bearer exact-internal-token"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 2,
        "run_id": "run-2",
        "candidates": [],
        "thread_operations": [],
        "action_operations": [],
    }
    assert len(service.calls) == 1
    assert service.calls[0].schema_version == 2


def test_extract_v2_preserves_explicit_null_thread_id_for_action_correction():
    from iris_worker.contracts import MemoryExtractionResponseV2

    response_model = MemoryExtractionResponseV2.model_validate(
        {
            "schema_version": 2,
            "run_id": "run-2",
            "candidates": [],
            "thread_operations": [],
            "action_operations": [
                {
                    "operation": "correct",
                    "operation_key": "action:correct:unlink",
                    "confidence": 0.9,
                    "evidence_message_ids": ["message-1"],
                    "evidence_span": "Remove the thread link.",
                    "action_id": "action-1",
                    "expected_version": 1,
                    "corrected_fields": ["thread_id"],
                    "thread_id": None,
                }
            ],
        }
    )
    service = FakeService(response_model)

    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            json=valid_v2_request(),
            headers={"Authorization": "Bearer exact-internal-token"},
        )

    assert response.status_code == 200
    operation = response.json()["action_operations"][0]
    assert operation["corrected_fields"] == ["thread_id"]
    assert "thread_id" in operation
    assert operation["thread_id"] is None
    assert "description" not in operation
    assert "owner" not in operation


@pytest.mark.parametrize(
    ("code", "retry_after", "status", "expected_body"),
    [
        ("provider_timeout", None, 504, {"error": "provider_timeout"}),
        (
            "provider_rate_limited",
            120,
            429,
            {"error": "provider_rate_limited", "retry_after_seconds": 120},
        ),
        (
            "provider_unavailable",
            None,
            503,
            {"error": "provider_unavailable"},
        ),
        (
            "invalid_model_response",
            None,
            502,
            INVALID_MODEL_RESPONSE_FIXTURE,
        ),
    ],
)
def test_maps_only_bounded_machine_errors(code, retry_after, status, expected_body):
    from iris_worker.model_client import ModelClientError

    service = FakeService(error=ModelClientError(code, retry_after_seconds=retry_after))
    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            json=valid_request(),
            headers={"Authorization": "Bearer exact-internal-token"},
        )

    assert response.status_code == status
    assert response.json() == expected_body
    body = response.text
    assert "model.example" not in body
    assert "model-api-key" not in body
    assert "exact-internal-token" not in body
    assert "Launch is Thursday" not in body


def test_maps_extraction_parser_failure_without_details():
    from iris_worker.memory_extraction import InvalidModelResponse

    service = FakeService(error=InvalidModelResponse())
    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            json=valid_request(),
            headers={"Authorization": "Bearer exact-internal-token"},
        )

    assert response.status_code == 502
    assert response.json() == INVALID_MODEL_RESPONSE_FIXTURE


def test_validation_errors_do_not_echo_message_content():
    service = FakeService(valid_response())
    secret_message = "private-message-content-that-must-not-echo"
    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            json=valid_request(
                messages=[
                    {
                        "id": "message-1",
                        "sent_at": "2026-07-14T00:00:00.000Z",
                        "text": secret_message,
                        "unknown": True,
                    }
                ]
            ),
            headers={"Authorization": "Bearer exact-internal-token"},
        )

    assert response.status_code == 422
    assert response.content == b""
    assert secret_message not in response.text
    assert service.calls == []


def test_rejects_request_over_serialized_byte_budget():
    service = FakeService(valid_response())
    with make_test_client(service) as client:
        response = client.post(
            "/v1/memory/extract",
            content=b"x" * (512 * 1024 + 1),
            headers={
                "Authorization": "Bearer exact-internal-token",
                "Content-Type": "application/json",
            },
        )

    assert response.status_code == 413
    assert response.content == b""
    assert service.calls == []
