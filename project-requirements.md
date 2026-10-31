# Role and Objective
You are an expert full-stack engineer and multi-agent systems architect. Your task is to build a modern, secure, and scalable Pharmacy Delivery Management System using an end-to-end **TypeScript** stack.

The backend will use Node.js with the **Google Agent Development Kit for TypeScript (`@google/adk`)**, paired with **Supabase (PostgreSQL)** for data/auth, **React (Vite + Tailwind)** for the frontend, and **Kafka** for event-driven notifications.

---

## Tech Stack & Architecture
1. **Backend / Agents:** Node.js (TypeScript), **Google ADK (`@google/adk`)** for multi-agent workflows, and `zod` for type-safe tool definitions.
2. **Database & Auth:** **Supabase** (`@supabase/supabase-js`) for relational data, row-level security, and authentication.
3. **Frontend:** **React** (TypeScript, Vite, Tailwind CSS) for the Pharmacy & Driver web dashboards.
4. **Event Streaming / Notifications:** **Kafka** (via `kafkajs`) to handle asynchronous notification events.

---

## Phase 1: Core Requirements & Implementation Steps

### 1. Authentication & Role Management
- Implement Supabase Auth integrated with PostgreSQL roles.
- Define two primary user roles with Row Level Security (RLS):
  - **Pharmacies:** Can manage medications, view assigned drivers, and track status.
  - **Drivers:** Can view available pickups, update delivery progress, and log coordinates.

### 2. Content & Medication Delivery Management
- Create a TypeScript backend API to manage medication inventory, prescription mappings, and delivery task creation assigned to specific pharmacies.

### 3. Progress Tracking & Analytics
- Track real-time driver status updates (`driver_progress` table).
- Provide endpoints/agents to compute analytics (total deliveries completed, active routes).

### 4. Event-Driven Notifications (Kafka)
- Produce Kafka events (`kafkajs`) for key delivery milestones:
  - `medication.ready`: Triggered when a pharmacy marks an order ready.
  - `driver.pickup`: Triggered when a driver accepts/picks up the package.
  - `delivery.completed`: Triggered upon successful drop-off.
- Build a consumer worker service to process these events and trigger notifications.

---

## Phase 2: Database Design (Supabase / PostgreSQL)
Generate the initial PostgreSQL migration schema with the following tables:

1. **`users` table:**
   - `id` (UUID, Primary Key, references Supabase `auth.users`)
   - `email` (Text, Unique)
   - `role` (Text: `'pharmacy'` | `'driver'` | `'admin'`)
   - `created_at` (Timestamp)

2. **`medications` table:**
   - `id` (UUID, Primary Key)
   - `pharmacy_id` (UUID, Foreign Key -> `users.id`)
   - `name` (Text)
   - `dosage` (Text)
   - `status` (Text: `'pending'`, `'ready'`, `'picked_up'`, `'delivered'`)
   - `created_at` (Timestamp)

3. **`driver_progress` table:**
   - `id` (UUID, Primary Key)
   - `medication_id` (UUID, Foreign Key -> `medications.id`)
   - `driver_id` (UUID, Foreign Key -> `users.id`)
   - `current_lat` (Numeric)
   - `current_lng` (Numeric)
   - `status` (Text)
   - `updated_at` (Timestamp)

---

## Google ADK TypeScript Integration Guidelines
- Utilize **Google ADK for TypeScript** (`import { LlmAgent, FunctionTool } from '@google/adk'`) to build specialized agents:
  - **DispatcherAgent:** Evaluates incoming medication orders and matches them with available drivers using type-safe Zod tool schemas.
  - **NotificationAgent:** Listens to Kafka event queues or triggers tool calls to dispatch automated messages based on status changes.
- Ensure all agent tools use `zod` for input validation so ADK correctly maps parameter types.

---

## Execution Instructions
Please start by generating:
1. The Supabase SQL schema migrations (including RLS policies).
2. The core configuration files and initialization code for the **TypeScript backend using `@google/adk`**.
3. A boilerplate structure for the React (TypeScript) frontend views (Pharmacy and Driver dashboards).