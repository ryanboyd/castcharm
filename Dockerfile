FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Create a non-root user that the app will run as after the entrypoint
# drops privileges. UID/GID 1000 matches the default first user on most
# Linux hosts, which simplifies bind-mount permissions for /downloads.
RUN groupadd --system --gid 1000 castcharm \
    && useradd --system --uid 1000 --gid castcharm --no-create-home castcharm

WORKDIR /app

# gosu is used by the entrypoint to safely drop from root to the app user
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ffmpeg \
        gosu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY static/ ./static/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && mkdir -p /data /downloads \
    && chown -R castcharm:castcharm /app /data /downloads

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8000/api/status || exit 1

# The entrypoint runs as root, fixes volume ownership, then drops to
# the castcharm user before executing the CMD.
ENTRYPOINT ["/entrypoint.sh"]

# --proxy-headers: trust X-Forwarded-* headers from an upstream reverse proxy.
# Remove this flag if you are running without a reverse proxy in front.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
