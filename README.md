# Pharmacy Delivery MVP

TypeScript MVP for pharmacy delivery workflows using Supabase, Google ADK, React, and Kafka.

## Phase 1: Database

The migrations in `supabase/migrations/` create Auth-linked profiles, pharmacy inventory, delivery orders, driver location history, RLS policies, and a transactional event outbox. Signup can assign only `pharmacy` or `driver`; `admin` can be assigned only by an existing admin or a trusted initial bootstrap.

Install and start Docker, then run `./tools/start_local.sh` to create the local Supabase stack and apply pending migrations without clearing existing local data. The script uses an installed Supabase CLI or downloads it through `npx` if needed. Use `--reset` only when you want to erase the local database and reapply every migration.

## Local setup

Copy `.env.example` to `.env` and add your Gemini API key. When it starts local Supabase, `tools/start_local.sh` reads the local API URL and keys from the Supabase CLI and passes them to the app without writing them to a file. If you connect to an already-running/remote Supabase project with `--no-supabase`, fill in the Supabase variables in `.env` too. Keep service-role and Gemini keys server-side; never expose them to the browser.

Users can create an account in the dashboard and choose Pharmacy or Driver. An existing admin can change account roles from the Administration screen. Bootstrap the first local admin once in Supabase Studio SQL Editor after creating that account through the UI:

```sql
update public.profiles set role = 'admin' where email = lower('admin@example.com');
```

Sign out and back in as that account to open role management. Self-service signup cannot grant the `admin` role.

When using the local stack, `tools/start_local.sh` also creates demo Pharmacy, Driver, and Admin accounts, sample inventory, prescription references, and delivery orders. Sign in with any of these local-only accounts (they all use the same password):

| Role | Email |
| --- | --- |
| Pharmacy | `demo.pharmacy@example.com` |
| Driver | `demo.driver@example.com` |
| Admin | `demo.admin@example.com` |

Password: `DemoDelivery123!`. These demo accounts are created only for a local Supabase URL and must never be used with a hosted or shared project. The Admin account can assign roles in the UI. `./tools/start_local.sh --reset` recreates the demo data after clearing the local database.

Start the local Supabase stack, Kafka broker, API, dashboard, and notification worker:

```sh
npm install
./tools/start_local.sh
```

Use `./tools/start_local.sh --reset` to reset the local database and reapply migrations. Resetting erases local database data. For separate terminal processes, `docker compose up -d` and `npm run dev` start Kafka and the API/dashboard; run `npm run worker` in another terminal.

The API exposes `/health`, `/api/orders`, pharmacy inventory and prescription-reference endpoints, order readiness/acceptance/pickup/completion endpoints, driver location updates, role-scoped analytics, and role-specific ADK assistants at `/api/assistant/dispatch`. The Pharmacy assistant answers delivery questions, creates or restocks medication items, and marks its pending orders ready. The Driver assistant answers route questions, accepts available deliveries, and marks assigned deliveries picked up or delivered. The Admin assistant reports workspace-wide delivery performance and account-role counts and remains read-only. Assistant tools use the caller-scoped database client and rely on role checks and row-level security. Creating an order checks and decrements stock in one database transaction. Prescription mappings contain only opaque external references; prescription contents and clinical verification remain in the pharmacy's existing system. The browser app uses Supabase Auth and has separate pharmacy and driver views.

User requests are authenticated with Supabase access tokens. Database requests use the caller's token and rely on RLS. Each role-specific assistant uses that same scoped database client; pharmacy tools can only change the caller’s own inventory and pending orders, driver tools can only claim unassigned ready orders or advance that driver’s assigned orders, and the admin assistant remains read-only.

## Current workflow

1. A pharmacy creates an order, which starts as `pending`.
2. The pharmacy marks it `ready`; the database writes a `medication.ready` outbox event.
3. A driver atomically accepts an unassigned ready order.
4. The driver marks it picked up and records location updates.
5. The driver marks it delivered; the database writes a `delivery.completed` outbox event.
6. The Kafka worker publishes outbox events and records deduplicated in-app notifications.

Driver-visible queue rows do not contain medication details or delivery addresses. A separate table and RLS policy reveal those details only to the pharmacy and the driver assigned to that delivery.

## Deploy to Google Cloud

The GitHub Actions workflow in `.github/workflows/deploy-gcp.yml` deploys on every push to `main` (and supports manual runs). It applies pending Supabase migrations, builds one container, deploys the web app and API together as a public Cloud Run service, and deploys the Kafka consumer as a one-instance Cloud Run Worker Pool. The browser and API share one origin; API routes still require Supabase access tokens. Supabase remains the database and Auth provider.

The workflow targets a managed Kafka service with KafkaJS-compatible TLS/SCRAM authentication, such as Aiven or Confluent Cloud. Create the `delivery.milestones` topic and grant the worker credentials permission to produce and consume that topic. The current local Docker Kafka remains plaintext; the worker uses TLS/SCRAM when `KAFKA_SECURITY_PROTOCOL=sasl_ssl`. Google Cloud's Managed Service for Apache Kafka can also work, but its non-Java OAuth setup needs an auth sidecar, so this initial workflow uses a KafkaJS-native SCRAM provider.

### One-time cloud bootstrap

Run `tools/bootstrap_gcp.sh` once from a terminal where you are signed in to both Google Cloud (`gcloud auth login`) and GitHub (`gh auth login`). It creates/enables the GCP APIs, Artifact Registry Docker repository, deployer and runtime service accounts, GitHub Workload Identity Federation restricted to this repository's `main` branch, and the four Secret Manager entries. It also sets the GitHub Actions variables required by the workflow. It never modifies the existing `SUPABASE_ACCESS_TOKEN` or `SUPABASE_DB_PASSWORD` GitHub secrets, and it does not create service-account JSON keys.

The script asks for the project ID, region, GitHub `OWNER/NAME`, hosted Supabase URL/ref/public key, model name, and Aiven broker/mechanism. It asks for the Supabase server-side key, Gemini API key, and Kafka username/password with input hidden, then stores them in Google Secret Manager. Existing Secret Manager values are preserved. Ensure the Kafka service is running, create the `delivery.milestones` topic, and grant the Aiven user produce/consume access before supplying its credentials. The GCP project must have billing enabled, and your Google identity needs permission to enable APIs, create resources, and grant IAM roles.

The workflow still needs the existing GitHub Actions secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`; the migration step runs `supabase db push --linked` before deploying. Keep production migrations additive and review them before merging to `main`.

The deployment workflow does not seed demo users or sample records into the hosted database. Demo data is only created by the local startup script.
