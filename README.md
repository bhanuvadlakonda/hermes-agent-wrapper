# Hermes Direct Railway Wrapper

Railway deploy wrapper for `nousresearch/hermes-agent`.

This repository preserves the production Railway behavior that is not present in the raw upstream image:

- Runs the Hermes gateway.
- Starts the Hermes dashboard on loopback only.
- Exposes a Basic Auth dashboard proxy on Railway's public `$PORT`.
- Provides `/__health` for Railway health checks.
- Keeps Hermes state on the Railway volume mounted at `/opt/data`.

## Required Railway Variables

Secrets stay in Railway, not in this repository.

- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD`
- `HERMES_HOME=/opt/data`
- `HERMES_TIMEZONE=Asia/Singapore`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL=https://api.openai.com/v1`
- `MIGRATION_MODE=0`

Existing messaging variables and Hermes provider settings remain in Railway or `/opt/data`.

## Update Flow

The base image is `nousresearch/hermes-agent:main`.

The scheduled `Check Hermes image` workflow resolves the current Docker Hub digest and opens a pull request when it changes. Merging that PR lets Railway deploy the latest upstream Hermes image while keeping this wrapper's dashboard protection intact.

## Verification

After deployment:

```bash
curl -fsS https://hermes-agent-direct-production.up.railway.app/__health
curl -I https://hermes-agent-direct-production.up.railway.app/
```

Expected:

- `/__health` returns `200`.
- `/` returns `401` until dashboard credentials are supplied.
