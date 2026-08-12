# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:0.11.7 AS uv

FROM python:3.12.11-slim-bookworm AS runtime
LABEL org.opencontainers.image.source="https://github.com/CopilotKit/OpenTag"
LABEL org.opencontainers.image.licenses="MIT"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
WORKDIR /app
COPY --from=uv /uv /uvx /bin/
COPY agent/pyproject.toml agent/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY agent/*.py ./
COPY agent/prompts ./prompts
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev \
    && useradd --uid 10001 --create-home --home-dir /home/opentag opentag
ENV PATH=/app/.venv/bin:$PATH
USER opentag
EXPOSE 8123
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.getenv('SERVER_PORT', '8123')}/health\", timeout=3)"]
CMD ["python", "main.py"]
