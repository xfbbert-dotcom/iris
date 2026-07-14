from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit

DEFAULT_MODEL_TIMEOUT_MS = 30_000
DEFAULT_MODEL_MAX_RESPONSE_BYTES = 65_536
DEFAULT_PORT = 8000
MAX_MODEL_TIMEOUT_MS = 120_000
MAX_MODEL_RESPONSE_BYTES = 1_048_576


@dataclass(frozen=True, slots=True)
class Settings:
    internal_token: str
    model_base_url: str
    model_api_key: str
    model_name: str
    model_timeout_ms: int
    model_max_response_bytes: int
    port: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        values = os.environ if env is None else env
        return cls(
            internal_token=_required_header_value(
                values, "IRIS_AI_WORKER_TOKEN", max_chars=4096
            ),
            model_base_url=_read_model_base_url(values),
            model_api_key=_required_header_value(
                values, "IRIS_MODEL_API_KEY", max_chars=4096
            ),
            model_name=_required_value(values, "IRIS_MODEL_NAME", max_chars=512),
            model_timeout_ms=_bounded_integer(
                values,
                "IRIS_MODEL_TIMEOUT_MS",
                default=DEFAULT_MODEL_TIMEOUT_MS,
                minimum=1,
                maximum=MAX_MODEL_TIMEOUT_MS,
            ),
            model_max_response_bytes=_bounded_integer(
                values,
                "IRIS_MODEL_MAX_RESPONSE_BYTES",
                default=DEFAULT_MODEL_MAX_RESPONSE_BYTES,
                minimum=1024,
                maximum=MAX_MODEL_RESPONSE_BYTES,
            ),
            port=_bounded_integer(
                values,
                "IRIS_AI_WORKER_PORT",
                default=DEFAULT_PORT,
                minimum=1,
                maximum=65_535,
            ),
        )


def _required_value(
    env: Mapping[str, str], name: str, *, max_chars: int
) -> str:
    value = env.get(name, "").strip()
    if not value or len(value) > max_chars:
        raise ValueError(f"{name} must be nonblank and at most {max_chars} characters")
    return value


def _required_header_value(
    env: Mapping[str, str], name: str, *, max_chars: int
) -> str:
    value = _required_value(env, name, max_chars=max_chars)
    if not value.isascii() or any(character.isspace() for character in value):
        raise ValueError(f"{name} must be an ASCII header token without whitespace")
    return value


def _read_model_base_url(env: Mapping[str, str]) -> str:
    name = "IRIS_MODEL_BASE_URL"
    value = _required_value(env, name, max_chars=2048)
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            f"{name} must be a credential-free http(s) URL without query or fragment"
        )
    try:
        parsed.port
    except ValueError as error:
        raise ValueError(f"{name} has an invalid port") from error
    return value.rstrip("/")


def _bounded_integer(
    env: Mapping[str, str],
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = env.get(name)
    value = str(default) if raw is None else raw
    if not value.isascii() or not value.isdecimal():
        raise ValueError(f"{name} must be a decimal integer")
    parsed = int(value, 10)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed
