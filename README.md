# ForgeFlow (V1 Foundation)

ForgeFlow is a distributed job-processing platform designed to be progressively evolved from a clean foundation into a production-grade cloud system.

In **V1 (Foundation)**, the core architectural foundation is established using React, Node.js + Express, and PostgreSQL with JWT authentication. No premature queueing, containerization, or background workers are added yet—jobs are recorded directly in PostgreSQL with a `PENDING` status.

---

## 1. Project Purpose

The purpose of ForgeFlow is to provide a reliable, transparent, and scalable job-processing platform. V1 establishes:
- Secure JWT-based authentication (register, login, me).
- Relational schema modeling for jobs and users in PostgreSQL.
- REST API with validation, error handling, and clean layered architecture.
- Real-time dashboard for job creation, metrics tracking, and status inspection.

---

## 2. Architecture

ForgeFlow is organized as a lightweight monorepo:

```
forgeflow/
├── apps/
│   ├── web/            # React + Vite + TypeScript Frontend
│   └── api/            # Express + TypeScript Backend
├── packages/
│   └── shared/         # Shared types, models, enums, and DTOs
├── docs/
│   └── architecture-v1.md # Educational design notes
├── .gitignore
├── README.md
└── package.json        # Monorepo root with npm workspaces
```

### Flow (V1)
```
[React Web Dashboard (Vite)] ──HTTP (JWT)──> [Express API Server] ──SQL (pg pool)──> [PostgreSQL Database]
```

---

## 3. Local Setup & Prerequisites

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **PostgreSQL**: v13.0 or higher running locally or remotely

### Installation (Native)
Clone the repository and install all dependencies from the root:

```bash
cd forgeflow
npm install
```

---

## 3.1 Docker Compose Setup (Recommended)

To run the entire stack (PostgreSQL, Express API, and React Web Dashboard) in isolated containers:

```bash
# Build images
docker compose build

# Start all services
docker compose up
```

- **Web Dashboard**: http://localhost:5173
- **API Server**: http://localhost:4000
- **PostgreSQL**: localhost:5432 (persisted in volume `forgeflow_postgres_data`)

To stop containers:
```bash
docker compose down
```

---

## 4. Environment Variables

Create `.env` in `apps/api/.env` (or copy from `.env.example`):

```bash
# apps/api/.env

PORT=4000
NODE_ENV=development

# PostgreSQL Connection String
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/forgeflow

# JWT Secret & Expiration
JWT_SECRET=super_secret_jwt_key_change_me_in_production
JWT_EXPIRES_IN=7d

# CORS Origin
CORS_ORIGIN=http://localhost:5173
```

---

## 5. Database Setup & Migrations

1. Ensure PostgreSQL is running and create the `forgeflow` database if it does not exist:

```sql
CREATE DATABASE forgeflow;
```

2. Run the SQL migrations runner to create the tables (`schema_migrations`, `users`, `jobs`) and indexes:

```bash
npm run migrate
```

Migrations are stored in `apps/api/src/db/migrations/001_init.sql` and tracked inside the `schema_migrations` table.

---

## 6. How to Run Frontend

To run the Vite React dashboard:

```bash
npm run dev:web
```

The frontend will be available at: **http://localhost:5173**

---

## 7. How to Run Backend

To run the Express API in development mode (with hot-reloading via `tsx`):

```bash
npm run dev:api
```

To build and run in production mode:

```bash
npm run build
npm start --workspace=apps/api
```

The API will be available at: **http://localhost:4000**

---

## 8. API Endpoints Reference

### Authentication

#### Register a new user
```http
POST /auth/register
Content-Type: application/json

{
  "name": "Alex Johnson",
  "email": "alex@example.com",
  "password": "secretpassword123"
}
```
**Response (201 Created):**
```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "c1f7b880-...",
    "email": "alex@example.com",
    "name": "Alex Johnson",
    "createdAt": "2026-09-23T15:30:00.000Z",
    "updatedAt": "2026-09-23T15:30:00.000Z"
  }
}
```

#### Login
```http
POST /auth/login
Content-Type: application/json

{
  "email": "alex@example.com",
  "password": "secretpassword123"
}
```
**Response (200 OK):**
```json
{
  "token": "eyJhbGciOi...",
  "user": { ... }
}
```

#### Get Current User Profile
```http
GET /auth/me
Authorization: Bearer <JWT_TOKEN>
```
**Response (200 OK):**
```json
{
  "id": "c1f7b880-...",
  "email": "alex@example.com",
  "name": "Alex Johnson",
  "createdAt": "2026-09-23T15:30:00.000Z",
  "updatedAt": "2026-09-23T15:30:00.000Z"
}
```

---

### Jobs

All job endpoints require `Authorization: Bearer <JWT_TOKEN>`.

#### Create a Job
```http
POST /jobs
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "type": "PDF_GENERATION",
  "payload": {
    "templateId": "invoice-v1",
    "recipient": "client@example.com",
    "items": [{ "description": "Consulting", "amount": 1500 }]
  }
}
```
*Supported Job Types:* `PDF_GENERATION`, `DATA_PROCESSING`, `AI_SUMMARY`, `EMAIL`, `CUSTOM`.

**Response (201 Created):**
```json
{
  "id": "9d8b13a7-...",
  "userId": "c1f7b880-...",
  "type": "PDF_GENERATION",
  "payload": { ... },
  "status": "PENDING",
  "createdAt": "2026-09-23T15:35:00.000Z",
  "updatedAt": "2026-09-23T15:35:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "error": null
}
```

#### List Jobs & Summary Stats
```http
GET /jobs?status=PENDING&type=PDF_GENERATION&limit=50&offset=0
Authorization: Bearer <JWT_TOKEN>
```
**Response (200 OK):**
```json
{
  "jobs": [ ... ],
  "total": 1,
  "stats": {
    "total": 5,
    "pending": 2,
    "running": 0,
    "completed": 2,
    "failed": 0,
    "cancelled": 1
  }
}
```

#### Get Job by ID
```http
GET /jobs/:id
Authorization: Bearer <JWT_TOKEN>
```
**Response (200 OK):**
```json
{
  "id": "9d8b13a7-...",
  "userId": "c1f7b880-...",
  "type": "PDF_GENERATION",
  "payload": { ... },
  "status": "PENDING",
  "createdAt": "2026-09-23T15:35:00.000Z",
  "updatedAt": "2026-09-23T15:35:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "error": null
}
```

#### Cancel a Pending Job
```http
POST /jobs/:id/cancel
Authorization: Bearer <JWT_TOKEN>
```
**Response (200 OK):**
```json
{
  "id": "9d8b13a7-...",
  "status": "CANCELLED",
  "updatedAt": "2026-09-23T15:40:00.000Z",
  ...
}
```
