# Pharmacy Delivery MVP

A TypeScript application for coordinating prescription deliveries between pharmacies and drivers. It combines a React dashboard, a Fastify API, Supabase authentication and PostgreSQL, role-specific Google ADK assistants, and Kafka-based delivery notifications.

## Features

- Pharmacy inventory and delivery order management, including stock checks and updates.
- Driver pickup queue, delivery status updates, and location recording.
- Admin role management and delivery analytics.
- Pharmacy, driver, and read-only admin AI assistants.
- Row-level security (RLS) for role-scoped access to delivery and account data.
- Asynchronous milestone notifications using a database outbox and Kafka.

Prescription mappings store opaque references only. Prescription contents and clinical verification remain in the pharmacy's existing system.

## Architecture

- `web/`: React, TypeScript, Vite, and Tailwind dashboard.
- `server/`: Fastify API and Kafka notification worker.
- `agent.ts`: role-specific assistants and their tools.
- `supabase/migrations/`: database schema, RLS policies, and functions.
- `tools/`: local startup, demo seeding, and Google Cloud bootstrap scripts.

The browser authenticates with Supabase and sends access tokens to the API. User-scoped database requests rely on PostgreSQL RLS. A transactional outbox records delivery milestones; the worker publishes these to Kafka and records deduplicated in-app notifications.

## Run Locally

Requirements: Node.js 22+, Docker, and an internet connection for the Supabase CLI if it is not already installed.

1. Copy `.env.example` to `.env` and add your Gemini API key.
2. Start the local services:

   ```sh
   npm install
   ./tools/start_local.sh
   ```

The startup script starts the local Supabase stack, applies pending migrations without clearing existing data, starts Kafka, and runs the API, dashboard, and notification worker. It reads local Supabase URLs and keys from the Supabase CLI without writing them to a file.

To run processes separately, start Kafka and the API/dashboard with `docker compose up -d` and `npm run dev`, then run `npm run worker` in another terminal. For a production build, run `npm run build`.

To connect to an already-running or hosted Supabase project instead, use `./tools/start_local.sh --no-supabase` and set the required Supabase variables in `.env`.

### Local Demo Accounts

The local startup script creates sample inventory, prescription references, orders, and these accounts. All use password `DemoDelivery123!`.

| Role | Email |
| --- | --- |
| Pharmacy | `demo.pharmacy@example.com` |
| Driver | `demo.driver@example.com` |
| Admin | `demo.admin@example.com` |

These accounts are created only for a local Supabase URL. Never use them with a hosted or shared project. To erase local database data and reapply all migrations, run `./tools/start_local.sh --reset`; this also recreates the demo data.

### Roles and Access

Self-service signup can select Pharmacy or Driver, but cannot grant Admin. To bootstrap the first local admin, create an account through the UI, then run this once in Supabase Studio's SQL Editor:

```sql
update public.profiles set role = 'admin' where email = lower('admin@example.com');
```

Sign out and back in as that account to access role management. After bootstrap, an existing admin can change roles in the Administration screen.

## Delivery Workflow

1. A pharmacy creates an order, which starts as `pending`; the database checks and decrements stock in one transaction.
2. The pharmacy marks the order `ready`, creating a `medication.ready` outbox event.
3. A driver atomically accepts an unassigned ready order, marks it picked up, and can record location updates.
4. The driver marks it delivered, creating a `delivery.completed` event.
5. The Kafka worker publishes events and records in-app notifications.

Driver queue rows do not expose medication details or delivery addresses. RLS allows those details only to the pharmacy and the driver assigned to the delivery. Assistants use the caller-scoped database client and follow the same role and RLS restrictions; the admin assistant is read-only.

## Deploy to Google Cloud

The GitHub Actions workflow at `.github/workflows/deploy-gcp.yml` deploys on pushes to `main` and supports manual runs. It applies pending Supabase migrations, builds one container, deploys the web app and API as a public Cloud Run service, and deploys the Kafka consumer as a one-instance Cloud Run Worker Pool. API routes still require Supabase access tokens; Supabase remains the database and Auth provider.

The workflow expects a managed Kafka service with KafkaJS-compatible TLS/SCRAM authentication (for example, Aiven or Confluent Cloud), with a `delivery.milestones` topic and worker credentials allowed to produce and consume. Local Docker Kafka uses plaintext; set `KAFKA_SECURITY_PROTOCOL=sasl_ssl` for the hosted TLS/SCRAM connection.

Run `tools/bootstrap_gcp.sh` once while authenticated with `gcloud auth login` and `gh auth login`. It configures GCP APIs, Artifact Registry, service accounts, repository-restricted GitHub Workload Identity Federation, Secret Manager entries, and workflow variables. It prompts for configuration and hides secret input. The GCP project needs billing enabled and your Google identity needs permission to create resources and grant IAM roles.

The deployment workflow requires GitHub Actions secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_URL`. Set `SUPABASE_DB_URL` to the project's Session pooler connection string from Supabase's Connect dialog, with the password filled in; use port `5432` for session mode, which supports IPv4-only runners. The workflow applies migrations with `supabase db push --remote="$SUPABASE_DB_URL" --yes` before deployment. Review production migrations and keep them additive before merging to `main`. Hosted deployment does not seed demo accounts or sample data.

## Security

Keep `.env`, Supabase service-role keys, Gemini API keys, and Kafka credentials out of version control. Service-role and model keys must remain server-side. Preserve caller-scoped Supabase requests and RLS boundaries when changing API or assistant tools.
