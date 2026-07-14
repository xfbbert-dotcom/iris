import pytest


def valid_env(**overrides: str) -> dict[str, str]:
    env = {
        "IRIS_AI_WORKER_TOKEN": "internal-worker-token",
        "IRIS_MODEL_BASE_URL": "https://model.example/v1/",
        "IRIS_MODEL_API_KEY": "model-api-key",
        "IRIS_MODEL_NAME": "extractor-model",
    }
    env.update(overrides)
    return env


def load_settings(env: dict[str, str]):
    from iris_worker.config import Settings

    return Settings.from_env(env)


def test_loads_valid_configuration_and_normalizes_base_url():
    settings = load_settings(valid_env())

    assert settings.internal_token == "internal-worker-token"
    assert settings.model_base_url == "https://model.example/v1"
    assert settings.model_api_key == "model-api-key"
    assert settings.model_name == "extractor-model"
    assert settings.model_timeout_ms == 30_000
    assert settings.model_max_response_bytes == 65_536
    assert settings.port == 8000


@pytest.mark.parametrize(
    "name",
    [
        "IRIS_AI_WORKER_TOKEN",
        "IRIS_MODEL_BASE_URL",
        "IRIS_MODEL_API_KEY",
        "IRIS_MODEL_NAME",
    ],
)
@pytest.mark.parametrize("value", ["", "   "])
def test_required_configuration_is_nonblank(name: str, value: str):
    with pytest.raises(ValueError, match=name):
        load_settings(valid_env(**{name: value}))


@pytest.mark.parametrize(
    "name",
    ["IRIS_AI_WORKER_TOKEN", "IRIS_MODEL_API_KEY"],
)
@pytest.mark.parametrize(
    "value",
    [
        "token\x00value",
        "token\nvalue",
        "token\x7fvalue",
        "token,value",
        "token-value-\u2603",
    ],
)
def test_bearer_tokens_are_visible_ascii_single_header_values(name: str, value: str):
    with pytest.raises(ValueError, match=name):
        load_settings(valid_env(**{name: value}))


@pytest.mark.parametrize(
    "url",
    [
        "model.example/v1",
        "ftp://model.example/v1",
        "https://user:model-secret@model.example/v1",
        "https://model.example/v1?api_key=secret",
        "https://model.example/v1#fragment",
        "https:///missing-host",
        "\nhttps://model.example/v1",
        "https://model.example/v1\x00",
        "https://model.example/v\t1",
        "https://model.example/v 1",
        "https://model.example/v1\x7f",
        "https://model.example/v1\u0080",
    ],
)
def test_model_base_url_must_be_credential_free_http_or_https(url: str):
    with pytest.raises(ValueError, match="IRIS_MODEL_BASE_URL"):
        load_settings(valid_env(IRIS_MODEL_BASE_URL=url))


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("IRIS_MODEL_TIMEOUT_MS", "0"),
        ("IRIS_MODEL_TIMEOUT_MS", "120001"),
        ("IRIS_MODEL_TIMEOUT_MS", "1.5"),
        ("IRIS_MODEL_MAX_RESPONSE_BYTES", "1023"),
        ("IRIS_MODEL_MAX_RESPONSE_BYTES", "1048577"),
        ("IRIS_AI_WORKER_PORT", "0"),
        ("IRIS_AI_WORKER_PORT", "65536"),
        ("IRIS_AI_WORKER_PORT", "not-an-integer"),
    ],
)
def test_numeric_configuration_is_strictly_bounded(name: str, value: str):
    with pytest.raises(ValueError, match=name):
        load_settings(valid_env(**{name: value}))
