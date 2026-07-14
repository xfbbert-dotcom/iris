from __future__ import annotations

import uvicorn

from .api import create_app
from .config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",
        port=settings.port,
        access_log=False,
    )


if __name__ == "__main__":
    main()
