# TripTrace Research GCP baseline

Known successful deployment baseline as of 2026-07-20. Verify every item before acting; these identifiers are deployment metadata, not credentials.

| Setting | Expected value |
| --- | --- |
| Google Cloud project ID | `openaibuildweek` |
| Google Cloud project number | `953007457230` |
| Region | `asia-east1` |
| Cloud Run service | `triptrace-research` |
| Expected public URL | `https://triptrace-research-953007457230.asia-east1.run.app` |
| Runtime service account | `triptrace-run@openaibuildweek.iam.gserviceaccount.com` |
| OpenAI secret name | `triptrace-openai-key` |
| Cache bucket | `openaibuildweek-triptrace-cache` |
| Cache mount | `/cache` |
| App cache directory | `/cache/triptrace-research` |
| Lifecycle definition | `deploy/gcs-lifecycle.json` (delete objects after 8 days) |
| Automatic source-deploy Artifact Registry repo | `cloud-run-source-deploy` in `asia-east1` |

## Production contract

The service is public and uses request-based Cloud Run billing with scale-to-zero. Preserve these settings unless the user explicitly changes them:

| Setting | Value |
| --- | --- |
| Port | `8080` |
| CPU / memory | `1` vCPU / `1Gi` |
| Concurrency | `2` |
| Max instances | `1` |
| Request timeout | `300` seconds |
| Execution environment | second generation |
| Startup CPU boost | enabled |
| Runtime | `TRIPTRACE_RUNTIME=production` |
| Cache environment | `TRIPTRACE_CACHE_DIR=/cache/triptrace-research` |
| OpenAI key | `OPENAI_API_KEY` from Secret Manager only |

The current production Dockerfile intentionally does not install `yt-dlp`. The public app serves verified snapshots and still-valid cache data only; do not reintroduce live YouTube research during a deployment.

## Read-only preflight

Use task-specific shell variables, not global gcloud configuration changes:

```bash
APP_PROJECT=openaibuildweek
APP_REGION=asia-east1
APP_SERVICE=triptrace-research
APP_RUNTIME_SA=triptrace-run@openaibuildweek.iam.gserviceaccount.com
APP_SECRET=triptrace-openai-key
APP_CACHE_BUCKET=openaibuildweek-triptrace-cache

gcloud auth list
gcloud projects describe "$APP_PROJECT"
gcloud billing projects describe "$APP_PROJECT"
gcloud run services describe "$APP_SERVICE" --project="$APP_PROJECT" --region="$APP_REGION"
gcloud run revisions list --service="$APP_SERVICE" --project="$APP_PROJECT" --region="$APP_REGION"
gcloud secrets describe "$APP_SECRET" --project="$APP_PROJECT"
gcloud storage buckets describe "gs://$APP_CACHE_BUCKET"
```

Do not use any command that reads a secret payload. Confirm the runtime identity can access the existing secret and write to the existing bucket. The expected minimal runtime roles are `roles/secretmanager.secretAccessor` on the secret and `roles/storage.objectUser` on the cache bucket; ask before changing IAM.

## Verification and lifecycle

Run these locally before a deployment:

```bash
npm test
npm run typecheck
npm run build
```

Verify or restore the existing lifecycle policy without deleting bucket contents:

```bash
gcloud storage buckets update "gs://$APP_CACHE_BUCKET" \
  --lifecycle-file=deploy/gcs-lifecycle.json
```

## Repeatable source deployment

Run only after all preflight checks pass and the user has authorized the deployment. This builds the current working tree with the repository `Dockerfile` and creates a new Cloud Run revision.

```bash
gcloud run deploy "$APP_SERVICE" \
  --source=. \
  --project="$APP_PROJECT" \
  --region="$APP_REGION" \
  --allow-unauthenticated \
  --execution-environment=gen2 \
  --service-account="$APP_RUNTIME_SA" \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=2 \
  --max-instances=1 \
  --timeout=300 \
  --cpu-boost \
  --update-env-vars=TRIPTRACE_RUNTIME=production,TRIPTRACE_CACHE_DIR=/cache/triptrace-research \
  --update-secrets=OPENAI_API_KEY="$APP_SECRET":latest \
  --add-volume=mount-path=/cache,type=cloud-storage,bucket="$APP_CACHE_BUCKET",readonly=false
```

`--update-secrets` deliberately refers to the existing secret and never contains its value. Retain `latest` because it matches the current service baseline; do not rotate, create, or print secret versions without explicit authorization.

Cloud Run's current volume syntax mounts Cloud Storage directly at `mount-path` for a single-container service. It needs the second-generation execution environment and a service identity with write access to the bucket. Official references: [Cloud Storage volume mounts](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts), [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets), and [`gcloud run deploy`](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy).

## Post-deploy commands

```bash
APP_URL=$(gcloud run services describe "$APP_SERVICE" \
  --project="$APP_PROJECT" \
  --region="$APP_REGION" \
  --format='value(status.url)')

gcloud run services describe "$APP_SERVICE" \
  --project="$APP_PROJECT" \
  --region="$APP_REGION"
gcloud run revisions list --service="$APP_SERVICE" \
  --project="$APP_PROJECT" \
  --region="$APP_REGION"
curl --fail --silent --show-error "$APP_URL" > /tmp/triptrace-cloud-run-home.html
```

Confirm the HTML contains the public snapshot/cache-first experience. Do not test a new unknown place as a live-research smoke test: production is intentionally expected to return source-unavailable on a cache miss.

## Known cost and operational guardrails

- Request-based billing plus `max-instances=1` and scale-to-zero keeps idle Cloud Run compute near zero.
- The GCS lifecycle removes runtime cache objects after eight days; app TTL is seven days.
- Artifact Registry retains source-deploy images. Do not add cleanup policies without first reviewing existing revisions and asking the user.
- Source deployment uses Cloud Build and Artifact Registry. If a required API is disabled, report the exact missing API and ask before enabling it.
- Do not use Cloud Run deployment to solve YouTube bot verification. The production design intentionally avoids `yt-dlp`.
