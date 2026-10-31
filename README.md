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

The API exposes `/health`, `/api/orders`, pharmacy inventory and prescription-reference endpoints, order readiness/acceptance/pickup/completion endpoints, driver location updates, role-scoped analytics, and a read-only ADK assistant at `/api/assistant/dispatch`. The Pharmacy assistant summarizes its delivery counts and ready queue; the Driver assistant summarizes available work and that driver's assignments; the Admin assistant reports workspace-wide delivery performance and account-role counts. Each assistant uses the caller-scoped database client and cannot change delivery or account state. Creating an order checks and decrements stock in one database transaction. Prescription mappings contain only opaque external references; prescription contents and clinical verification remain in the pharmacy's existing system. The browser app uses Supabase Auth and has separate pharmacy and driver views.

User requests are authenticated with Supabase access tokens. Database requests use the caller's token and rely on RLS. Each role-specific assistant uses that same scoped database client; the driver assistant only summarizes the signed-in driver's assignments and public ready-work counts.

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

The workflow targets a managed Kafka service with KafkaJS-compatible TLS/SCRAM authentication, such as Confluent Cloud. Create the `delivery.milestones` topic and grant the worker credentials permission to produce and consume that topic. The current local Docker Kafka remains plaintext; the worker uses TLS/SCRAM when `KAFKA_SECURITY_PROTOCOL=sasl_ssl`. Google Cloud's Managed Service for Apache Kafka can also work, but its non-Java OAuth setup needs an auth sidecar, so this initial workflow uses a KafkaJS-native SCRAM provider.

Before enabling the workflow:

1. In GCP, enable Cloud Run, Artifact Registry, Secret Manager, and IAM Credentials APIs. Create a Docker repository in Artifact Registry.
2. Create a GitHub Workload Identity Federation provider restricted to this repository's `main` branch, plus a deployer service account. Give the deployer permission to push to the Artifact Registry repository and deploy Cloud Run services/worker pools, and permission to act as the runtime service account. Use federation instead of a downloadable service-account key.
3. Create a Cloud Run runtime service account. Grant it Secret Manager Secret Accessor on the four secrets below.
4. Create these Secret Manager secrets and add values: `supabase-service-role-key`, `gemini-api-key`, `kafka-username`, and `kafka-password`.
5. Add the following GitHub Actions **variables**:

   - `GCP_PROJECT_ID`, `GCP_REGION`, and `GCP_ARTIFACT_REGISTRY_REPOSITORY`
   - `GCP_WORKLOAD_IDENTITY_PROVIDER` (the full provider resource name)
   - `GCP_DEPLOYER_SERVICE_ACCOUNT` and `GCP_RUNTIME_SERVICE_ACCOUNT` (service account emails)
   - `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`
   - `GEMINI_MODEL` (for example, `gemini-3.5-flash-lite`)
   - `KAFKA_BROKERS` (the managed Kafka bootstrap broker) and `KAFKA_SASL_MECHANISM` (`scram-sha-256` or `scram-sha-512`)

6. Add these GitHub Actions **secrets**: `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`. The migration step runs `supabase db push --linked` before deploying; keep production migrations additive and review them before merging to `main`.

The deployment workflow does not seed demo users or sample records into the hosted database. Demo data is only created by the local startup script.
