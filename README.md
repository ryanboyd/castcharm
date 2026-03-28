# CastCharm

A self-hosted podcast manager with a clean web UI. Subscribe to RSS feeds, auto-download episodes, track playback, and manage your library — all from a single Docker container.

![License](https://img.shields.io/github/license/ryanboyd/castcharm)
![Docker Image](https://img.shields.io/github/actions/workflow/status/ryanboyd/castcharm/docker.yml?label=docker%20build)

---

## Features

- **Feed management** — subscribe via RSS URL or add offline/manual feeds
- **Auto-download** — automatically download new episodes, with per-feed overrides and a keep-latest-N cleanup option
- **Playback tracking** — remembers position, marks episodes played, backlog stats
- **ID3 tagging** — write metadata to MP3 files with configurable field mappings
- **Clean RSS** — generates clean RSS feeds for use with podcast apps
- **Search** — full-text search across all episodes
- **Stats** — library-wide and per-feed statistics with charts
- **Themes** — 20+ built-in colour themes
- **Auth** — optional password protection
- **API** — full REST API with Swagger docs at `/api/docs`

---

## Quick Start

```bash
# 1. Download the compose file
curl -O https://raw.githubusercontent.com/ryanboyd/castcharm/main/docker-compose.yml

# 2. (Optional) configure paths and port
cp .env.example .env
$EDITOR .env

# 3. Start
docker compose up -d
```

Open **http://localhost:8000** — the setup wizard will guide you through initial configuration.

---

## Configuration

All configuration is done via environment variables (or a `.env` file next to `docker-compose.yml`).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Host port to expose |
| `DATA_PATH` | `./data` | Host path for the SQLite database and app state |
| `DOWNLOAD_PATH` | `./downloads` | Host path for downloaded audio files |

The `DATABASE_URL`, `DEFAULT_DOWNLOAD_PATH`, and `CLEAN_RSS_PATH` variables inside the container are set automatically by `docker-compose.yml` and don't normally need to be changed.

### Running behind a reverse proxy

The default `CMD` includes `--proxy-headers` so `X-Forwarded-*` headers from nginx/Caddy/Traefik are trusted. No extra configuration needed.

---

## Docker

### Pre-built image (GitHub Container Registry)

```yaml
services:
  castcharm:
    image: ghcr.io/ryanboyd/castcharm:latest
    container_name: castcharm
    ports:
      - "${PORT:-8000}:8000"
    volumes:
      - ${DATA_PATH:-./data}:/data
      - ${DOWNLOAD_PATH:-./downloads}:/downloads
    environment:
      - DATABASE_URL=sqlite:////data/castcharm.db
      - DEFAULT_DOWNLOAD_PATH=/downloads
      - CLEAN_RSS_PATH=/downloads/clean-rss
    restart: unless-stopped
```

### Build from source

```bash
git clone https://github.com/ryanboyd/castcharm
cd castcharm
docker compose up -d --build
```

---

## Data & Backups

- **Database**: `DATA_PATH/castcharm.db` — copy this file to back up all feeds, episodes, settings, and playback history.
- **Downloads**: `DOWNLOAD_PATH/` — your audio files, organised as `Podcast Name/YYYY/filename.mp3`.

To restore: stop the container, replace the files, start again.

---

## Development

```bash
# Install dependencies
pip install -r requirements.txt

# Run locally (SQLite in ./data, downloads in ./downloads)
DATABASE_URL=sqlite:///./data/castcharm.db \
DEFAULT_DOWNLOAD_PATH=./downloads \
uvicorn app.main:app --reload --port 8000
```

The frontend is plain HTML/CSS/JS — no build step required.

---

## License

MIT — see [LICENSE](LICENSE).
