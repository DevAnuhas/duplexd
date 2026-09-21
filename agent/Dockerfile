FROM dailyco/pipecat-base:0.1.29

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY duplexd_agent ./duplexd_agent
# Pipecat Cloud's base-image supervisor imports `bot.bot` from /app/bot.py.
# Keep the packaged module as the source of truth and expose that same file at
# the supervisor's required import path.
COPY duplexd_agent/bot.py ./bot.py

# The base image's /app/app.py supervisor owns its matching pipecatcloud
# runtime. Preserve that base dependency while installing this project's
# locked runtime; an exact sync removes it because it is not an application
# dependency, and the supervisor then dies before readiness can bind.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --inexact

ENV PATH="/app/.venv/bin:${PATH}"
