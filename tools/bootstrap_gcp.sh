#!/usr/bin/env bash
set -euo pipefail

# One-time GCP and GitHub Actions setup for deploy-gcp.yml.
# Run from a trusted terminal after authenticating with `gcloud auth login`
# and `gh auth login`. Secret values are entered without echo and are never
# written to disk or passed as command-line arguments.

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  printf 'Run this script, do not source it.\n' >&2
  return 1
fi

for command_name in gcloud gh; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || {
  printf 'Sign in to Google Cloud first: gcloud auth login\n' >&2
  exit 1
}
gh auth status >/dev/null 2>&1 || {
  printf 'Sign in to GitHub first: gh auth login\n' >&2
  exit 1
}

prompt() {
  local __name="$1" label="$2" default="${3:-}" value
  if [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " value
    value="${value:-$default}"
  else
    read -r -p "$label: " value
  fi
  if [[ -z "$value" ]]; then
    printf 'A value is required for %s.\n' "$label" >&2
    exit 1
  fi
  printf -v "$__name" '%s' "$value"
}

prompt_secret() {
  local __name="$1" label="$2" value
  read -r -s -p "$label: " value
  printf '\n'
  if [[ -z "$value" ]]; then
    printf 'A value is required for %s.\n' "$label" >&2
    exit 1
  fi
  printf -v "$__name" '%s' "$value"
}

printf 'This creates GCP resources and GitHub Actions variables/secrets.\n'
printf 'It does not change SUPABASE_ACCESS_TOKEN or SUPABASE_DB_PASSWORD.\n\n'

prompt PROJECT_ID 'Google Cloud project ID'
prompt REGION 'Cloud Run / Artifact Registry region' 'europe-west1'
prompt GITHUB_REPOSITORY 'GitHub repository (OWNER/NAME)'
prompt SUPABASE_PROJECT_REF 'Hosted Supabase project ref'
prompt SUPABASE_URL 'Hosted Supabase project URL'
prompt SUPABASE_ANON_KEY 'Supabase anon/publishable key'
prompt GEMINI_MODEL 'Gemini model' 'gemini-3.5-flash-lite'
prompt KAFKA_BROKERS 'Aiven SASL broker host:port'
prompt KAFKA_SASL_MECHANISM 'Aiven SCRAM mechanism (scram-sha-256 or scram-sha-512)' 'scram-sha-256'

if [[ "$GITHUB_REPOSITORY" != */* ]]; then
  printf 'GitHub repository must be OWNER/NAME.\n' >&2
  exit 1
fi
if [[ "$KAFKA_SASL_MECHANISM" != 'scram-sha-256' && "$KAFKA_SASL_MECHANISM" != 'scram-sha-512' ]]; then
  printf 'Kafka mechanism must be scram-sha-256 or scram-sha-512.\n' >&2
  exit 1
fi

printf '\nEnter the runtime credentials. Values are hidden while typing.\n'
read -r -p "Proceed to configure project '$PROJECT_ID' and GitHub repo '$GITHUB_REPOSITORY'? [y/N] " confirmation
if [[ "$confirmation" != [yY] && "$confirmation" != [yY][eE][sS] ]]; then
  printf 'Cancelled; no cloud resources were changed.\n'
  exit 0
fi

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  serviceusage.googleapis.com \
  sts.googleapis.com \
  --project "$PROJECT_ID"

DEPLOYER_ACCOUNT_ID='eda-github-deployer'
RUNTIME_ACCOUNT_ID='eda-cloud-run'
ARTIFACT_REPOSITORY='eda-logistics'
POOL_ID='github-actions'
PROVIDER_ID='github-main'

create_service_account_if_missing() {
  local account_id="$1" display_name="$2"
  if ! gcloud iam service-accounts describe "${account_id}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$account_id" \
      --display-name "$display_name" --project "$PROJECT_ID"
  fi
}

create_service_account_if_missing "$DEPLOYER_ACCOUNT_ID" 'GitHub Actions deployer'
create_service_account_if_missing "$RUNTIME_ACCOUNT_ID" 'EDA Logistics Cloud Run runtime'

DEPLOYER_SERVICE_ACCOUNT="${DEPLOYER_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" \
  --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" \
    --repository-format=docker --location "$REGION" \
    --description='EDA Logistics container images' --project "$PROJECT_ID"
fi

gcloud artifacts repositories add-iam-policy-binding "$ARTIFACT_REPOSITORY" \
  --location "$REGION" --project "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role='roles/artifactregistry.writer' >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role='roles/run.admin' >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SERVICE_ACCOUNT" \
  --project "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role='roles/iam.serviceAccountUser' >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --location=global --display-name='GitHub Actions' --project "$PROJECT_ID"
fi

PROVIDER_CONDITION="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.ref == 'refs/heads/main'"
PROVIDER_MAPPING='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref'
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --location=global --workload-identity-pool="$POOL_ID" \
  --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --location=global --workload-identity-pool="$POOL_ID" \
    --issuer-uri='https://token.actions.githubusercontent.com' \
    --attribute-mapping="$PROVIDER_MAPPING" \
    --attribute-condition="$PROVIDER_CONDITION" --project "$PROJECT_ID"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --location=global --workload-identity-pool="$POOL_ID" \
    --display-name='GitHub main branch' \
    --issuer-uri='https://token.actions.githubusercontent.com' \
    --attribute-mapping="$PROVIDER_MAPPING" \
    --attribute-condition="$PROVIDER_CONDITION" --project "$PROJECT_ID"
fi

gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SERVICE_ACCOUNT" \
  --project "$PROJECT_ID" \
  --role='roles/iam.workloadIdentityUser' \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPOSITORY}" >/dev/null

ensure_secret() {
  local secret_name="$1" label="$2" secret_value versions
  if ! gcloud secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$secret_name" --replication-policy=automatic --project "$PROJECT_ID"
  fi
  versions="$(gcloud secrets versions list "$secret_name" --project "$PROJECT_ID" --filter='state=ENABLED' --format='value(name)' 2>/dev/null || true)"
  if [[ -z "$versions" ]]; then
    prompt_secret secret_value "$label"
    printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" \
      --data-file=- --project "$PROJECT_ID"
    unset secret_value
  else
    printf 'Keeping existing Secret Manager value for %s.\n' "$secret_name"
  fi
  gcloud secrets add-iam-policy-binding "$secret_name" \
    --project "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role='roles/secretmanager.secretAccessor' >/dev/null
}

ensure_secret 'supabase-service-role-key' 'Supabase server-side service_role/secret key'
ensure_secret 'gemini-api-key' 'Gemini API key'
ensure_secret 'kafka-username' 'Aiven Kafka service username'
ensure_secret 'kafka-password' 'Aiven Kafka service password'

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
set_variable() {
  gh variable set "$1" --repo "$GITHUB_REPOSITORY" --body "$2"
}

set_variable GCP_PROJECT_ID "$PROJECT_ID"
set_variable GCP_REGION "$REGION"
set_variable GCP_ARTIFACT_REGISTRY_REPOSITORY "$ARTIFACT_REPOSITORY"
set_variable GCP_WORKLOAD_IDENTITY_PROVIDER "$WIF_PROVIDER"
set_variable GCP_DEPLOYER_SERVICE_ACCOUNT "$DEPLOYER_SERVICE_ACCOUNT"
set_variable GCP_RUNTIME_SERVICE_ACCOUNT "$RUNTIME_SERVICE_ACCOUNT"
set_variable SUPABASE_PROJECT_REF "$SUPABASE_PROJECT_REF"
set_variable SUPABASE_URL "$SUPABASE_URL"
set_variable SUPABASE_ANON_KEY "$SUPABASE_ANON_KEY"
set_variable GEMINI_MODEL "$GEMINI_MODEL"
set_variable KAFKA_BROKERS "$KAFKA_BROKERS"
set_variable KAFKA_SASL_MECHANISM "$KAFKA_SASL_MECHANISM"

printf '\nSetup complete. Existing GitHub Supabase secrets were left unchanged.\n'
printf 'The deploy workflow can now be run from GitHub Actions (or triggered by a push to main).\n'
