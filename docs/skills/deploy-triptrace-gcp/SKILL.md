---
name: deploy-triptrace-gcp
description: Deploy or inspect the existing TripTrace Research Google Cloud Run service safely. Use when asked to deploy, redeploy, verify, roll back, or change GCP production configuration for this repository, including its Cloud Storage cache or Secret Manager wiring.
---

# Deploy TripTrace Research to GCP

Read [references/gcp-baseline.md](references/gcp-baseline.md) before any GCP command. It records the known deployment target and the repeatable command; treat every value as a baseline to verify, not an instruction to create new infrastructure blindly.

## Scope and safety boundaries

- Deploy only after the user explicitly asks to deploy or redeploy.
- Preserve the public snapshot/cache-first architecture. Production must set `TRIPTRACE_RUNTIME=production`; a cache miss must not start `yt-dlp` or live YouTube research.
- Never print, read, write, stage, or commit `.env.local`. Never pass an OpenAI key as a command-line value, build argument, README value, or environment variable in source control.
- Use the existing Secret Manager reference only. If its secret, service account, bucket, or required IAM role is absent, stop and ask the user for authorization before changing IAM, enabling APIs, creating a secret, or creating a bucket.
- Do not reset, clean, discard, or overwrite unrelated uncommitted changes. This repository may contain active snapshot-generation work.
- Do not add a proxy, browser cookies, `yt-dlp`, or any YouTube-bypass mechanism to the production image.

## Preflight

1. Read the current `Dockerfile`, `README.md`, `deploy/gcs-lifecycle.json`, and the reference file.
2. Run `git status --short --branch`; identify whether the intended deployment includes uncommitted work. Do not deploy ambiguous changes.
3. Confirm authentication interactively with `gcloud auth list`. If authentication requires a browser or device verification flow, let the user complete it locally. Never ask them to paste a verification code, password, cookie, token, or API key into chat.
4. Use explicit `--project` and `--region` flags. Do not alter the developer's global gcloud default project.
5. Run the read-only preflight commands from the reference. Confirm the service URL, runtime service account, secret reference, Cloud Storage bucket, and lifecycle policy before a deploy.
6. Run the relevant checks: `npm test`, `npm run typecheck`, and `npm run build`.

## Deploy

Use the source-deploy command in the reference after the preflight succeeds. It intentionally:

- builds the repository's current `Dockerfile` through Cloud Build;
- exposes port `8080`;
- keeps the service public, request-based, scale-to-zero, and capped at one instance;
- mounts the existing Cloud Storage cache at `/cache` with write access;
- passes only a Secret Manager reference for `OPENAI_API_KEY`;
- sets `TRIPTRACE_CACHE_DIR=/cache/triptrace-research` and `TRIPTRACE_RUNTIME=production`.

Prefer `--update-env-vars` and `--update-secrets` over clearing all existing configuration. Do not change the secret version strategy, resource sizing, public access, volume mount, or cache policy unless the user asks.

Apply `deploy/gcs-lifecycle.json` only to the existing TripTrace cache bucket. It deletes cache objects after eight days; do not use destructive bucket commands.

## Post-deploy verification

1. Record the new revision and retrieve the URL from `gcloud run services describe`; do not assume the URL from this document is still current.
2. Request the public home page and verify an HTTP 200 response plus the snapshot/cache-first UI text.
3. Confirm the new revision still has the runtime service account, Secret Manager reference, `TRIPTRACE_RUNTIME=production`, cache directory, Cloud Storage mount, request-based billing, max instance cap, and public access.
4. Do not use a cache miss as a smoke test. In production it must return the honest source-unavailable state rather than run live YouTube research.
5. Inspect Cloud Run logs only for deployment/startup errors; do not print environment dumps or secret-bearing values.

## Failure and rollback

- If the Cloud Build or deployment fails, inspect the build/revision error, report it, and avoid repeated blind deploys.
- If the new revision is unhealthy, identify the prior serving revision with a read-only revisions list. Roll traffic back only after the user asks for rollback or explicitly authorizes the recovery action.
- Report the deployed revision, URL, checks, resource changes, cache status, and any remaining risk. State whether no secret values were exposed.
