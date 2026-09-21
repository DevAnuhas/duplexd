FROM dailyco/pipecat-base:0.1.29

WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /app/.venv/bin/python "pipecat-ai[daily,runner]==1.11.0"

COPY bot.py ./bot.py
ENV PATH="/app/.venv/bin:${PATH}"
