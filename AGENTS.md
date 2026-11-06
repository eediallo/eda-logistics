# Repository Guidelines

## Project Structure

This repository is a TypeScript pharmacy-delivery MVP. `web/src/` contains the React/Vite dashboard and styles; `server/src/` contains the Fastify API, auth integration, and Kafka worker; `agent.ts` defines the Google ADK assistants. Supabase configuration and SQL migrations are in `supabase/`. Local startup, seeding, and GCP bootstrap scripts are in `tools/`; Docker and deployment configuration are at the repository root and under `.github/workflows/`.

## Build and Development

- `npm install` installs dependencies.
- `./tools/start_local.sh` starts local Supabase, Kafka, API, dashboard, and notification worker; Docker is required.
- `npm run dev` starts the API and Vite dashboard in separate processes.
- `npm run worker` runs the Kafka notification worker separately.
- `npm run build` type-checks/compiles TypeScript and builds the Vite frontend.
- `./tools/start_local.sh --reset` clears and recreates the local database; use only when local data can be discarded.

## Code Style and Organization

Use TypeScript with the repository’s strict `tsconfig.json` settings. Follow nearby conventions: camelCase for variables/functions, PascalCase for React components and types, and descriptive kebab-free filenames consistent with existing modules. Validate API inputs with Zod, preserve role checks, and use caller-scoped Supabase clients for user requests so database RLS remains effective. No formatter or linter is currently configured; keep formatting consistent with adjacent code.

## Testing and Verification

There is no test script or test suite currently configured in `package.json`. For code changes, run `npm run build`; for database or workflow changes, use the local stack and inspect the affected user flow. Add tests when introducing test infrastructure, colocating them with the feature and using a clear `*.test.ts` or `*.test.tsx` name.

## Security and Configuration

Copy `.env.example` to `.env` for local configuration. Never commit `.env`, Supabase service-role keys, Gemini API keys, or Kafka credentials. Keep privileged keys server-side, preserve RLS boundaries, and do not seed demo accounts into hosted environments.

## Commits and Pull Requests

Recent commits use concise, imperative summaries (for example, “Add delivery analytics to the assistant”). Keep changes focused. PRs should explain the user-visible or database impact, link a related issue when available, list relevant verification, include screenshots for dashboard changes, and call out migration or configuration requirements.
