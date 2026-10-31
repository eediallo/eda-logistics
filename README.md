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
