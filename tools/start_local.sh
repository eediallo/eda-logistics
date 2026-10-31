#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

START_SUPABASE="${START_SUPABASE:-true}"
START_KAFKA="${START_KAFKA:-true}"
RESET_SUPABASE_DB="${RESET_SUPABASE_DB:-false}"
HARD_RESET="${HARD_RESET:-false}"
RELEASE_BUILD="${RELEASE_BUILD:-false}"
WEB_PORT="${WEB_PORT:-5173}"

usage() {
  cat <<'EOF'
Usage: tools/start_local.sh [options]

Starts the local Supabase stack, Kafka, API, web dashboard, and notification worker.

Options:
  --reset         Reset the local Supabase database and reapply migrations.
  --hard          Stop Supabase, then reset its local database and restart it.
  --no-supabase   Use an already-running Supabase project.
  --no-kafka      Skip Kafka and its notification worker.
  --release       Build the app and serve the production frontend/API.
  --web-port N    Serve the web dashboard on port N (default: 5173).
  -h, --help      Show this help.

The script reads GEMINI_API_KEY from .env and/or .env.local. It obtains local
Supabase keys from the CLI automatically. With --no-supabase, provide the
Supabase URL and keys in the environment file.
EOF
}

while (($#)); do
  case "$1" in
    --reset) RESET_SUPABASE_DB=true; shift ;;
    --hard) HARD_RESET=true; RESET_SUPABASE_DB=true; shift ;;
    --no-supabase) START_SUPABASE=false; shift ;;
    --no-kafka) START_KAFKA=false; shift ;;
    --release) RELEASE_BUILD=true; shift ;;
    --web-port)
      if (($# < 2)) || [[ ! "$2" =~ ^[0-9]+$ ]] || ((10#$2 < 1 || 10#$2 > 65535)); then
        echo "--web-port requires a port between 1 and 65535" >&2
        exit 2
      fi
      WEB_PORT="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -f "supabase/config.toml" || ! -f "docker-compose.yml" ]]; then
  echo "Run this script from the eda-logistics checkout; required Supabase or Kafka config is missing." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Node dependencies are missing. Run 'npm install' first." >&2
  exit 1
fi

env_files=()
[[ -f .env ]] && env_files+=(.env)
[[ -f .env.local ]] && env_files+=(.env.local)
if [[ -z "${GEMINI_API_KEY:-}" ]] && ((${#env_files[@]} == 0)); then
  echo "No .env or .env.local file found. Copy .env.example to .env and add your Gemini API key." >&2
  exit 1
fi

missing_env=()
required_env=(GEMINI_API_KEY)
if [[ "${START_SUPABASE}" != true ]]; then
  required_env+=(SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY)
fi
for key in "${required_env[@]}"; do
  if [[ -n "${!key:-}" ]]; then
    continue
  fi
  found=false
  for file in "${env_files[@]}"; do
    if rg -q "^[[:space:]]*(export[[:space:]]+)?${key}=" "${file}"; then
      found=true
      break
    fi
  done
  [[ "${found}" == true ]] || missing_env+=("${key}")
done

if ((${#missing_env[@]})); then
  printf 'Missing required settings in %s: %s\n' "${env_files[*]}" "${missing_env[*]}" >&2
  echo "Copy .env.example to .env and add your Gemini API key." >&2
  exit 1
fi

for file in "${env_files[@]}"; do
  if rg -qi 'your-gemini-api-key' "${file}"; then
    echo "Replace the GEMINI_API_KEY placeholder in ${file} before starting the app." >&2
    exit 1
  fi
  if [[ "${START_SUPABASE}" != true ]]; then
    if rg -qi 'your-project\.supabase\.co|your-supabase-anon-key|server-only-service-role-key' "${file}"; then
      echo "Replace the example placeholder values in ${file} before starting the app." >&2
      exit 1
    fi
  fi
done

need_docker=false
[[ "${START_SUPABASE}" == true || "${START_KAFKA}" == true ]] && need_docker=true
if [[ "${need_docker}" == true ]]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "Docker must be installed and running to start Supabase or Kafka." >&2
    exit 1
  fi
fi

if [[ "${START_SUPABASE}" == true ]]; then
  if command -v supabase >/dev/null 2>&1; then
    supabase_cli=(supabase)
  else
    supabase_cli=(npx --yes supabase@latest)
  fi

  if [[ "${HARD_RESET}" == true ]]; then
    "${supabase_cli[@]}" stop || true
  fi
  "${supabase_cli[@]}" start
  if [[ "${RESET_SUPABASE_DB}" == true ]]; then
    echo "Resetting the local Supabase database and reapplying migrations..."
    "${supabase_cli[@]}" db reset
  else
    echo "Applying pending Supabase migrations..."
    "${supabase_cli[@]}" migration up --local
  fi

  # Use the keys emitted by the local CLI without writing them into a tracked file.
  while IFS= read -r line; do
    [[ "${line}" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#export }"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    case "${key}" in
      API_URL) export SUPABASE_URL="${value}" VITE_SUPABASE_URL="${value}" ;;
      PUBLISHABLE_KEY|ANON_KEY) export SUPABASE_ANON_KEY="${value}" VITE_SUPABASE_ANON_KEY="${value}" ;;
      SECRET_KEY|SERVICE_ROLE_KEY) export SUPABASE_SERVICE_ROLE_KEY="${value}" ;;
    esac
  done < <("${supabase_cli[@]}" status --output env)

  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_ANON_KEY:-}" || -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    echo "Could not read the local Supabase API URL and keys from 'supabase status --output env'." >&2
    exit 1
  fi

  echo "Preparing local demo accounts, inventory, and delivery orders..."
  node --import tsx tools/seed_demo.ts
fi

if [[ "${START_KAFKA}" == true ]]; then
  docker compose up -d --wait kafka
fi

if [[ "${RELEASE_BUILD}" == true ]]; then
  npm run build
fi

child_pids=()
cleanup() {
  local pid
  for pid in "${child_pids[@]:-}"; do
    kill "${pid}" 2>/dev/null || true
  done
  for pid in "${child_pids[@]:-}"; do
    wait "${pid}" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

if [[ "${START_KAFKA}" == true ]]; then
  if [[ "${RELEASE_BUILD}" == true ]]; then
    npm run start:worker &
  else
    npm run worker &
  fi
  child_pids+=("$!")
fi

if [[ "${RELEASE_BUILD}" == true ]]; then
  npm start &
  child_pids+=("$!")
  VITE_PORT="${WEB_PORT}" npx vite preview --host 127.0.0.1 --port "${WEB_PORT}" --strictPort
else
  VITE_PORT="${WEB_PORT}" npm run dev
fi
