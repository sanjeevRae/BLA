# BLA Backend (FastAPI)

Monolithic FastAPI service implementing the platform's business logic.

## Layout

```
backend/
├── app/
│   ├── main.py            # FastAPI app + CORS + router wiring
│   ├── core/
│   │   ├── config.py      # pydantic-settings (all env vars)
│   │   └── supabase_client.py
│   ├── routers/           # HTTP endpoints
│   │   ├── orders.py      # create/list/status/assign
│   │   ├── drivers.py     # assignments, status, GPS, POD upload
│   │   ├── analytics.py   # dashboard metrics
│   │   └── tasks.py       # cron-triggered jobs (daily report, gps cleanup)
│   ├── schemas/           # Pydantic request/response models
│   ├── services/          # business logic
│   │   ├── orders.py      # order creation + driver assignment
│   │   ├── routing.py     # MapTiler -> OpenRouteService fallback
│   │   ├── notifications.py  # EmailJS + Textlocal
│   │   ├── storage.py     # Cloudinary POD uploads
│   │   ├── realtime.py    # Supabase Realtime writes (+ Redis scaling note)
│   │   └── analytics.py
│   └── models/            # placeholder (schema lives in db/schema.sql)
├── requirements.txt
└── render.yaml            # Render deployment blueprint
```

## Run locally

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env      # then fill in your keys
uvicorn app.main:app --reload --port 8000
```

Interactive docs at <http://localhost:8000/docs>.

## Key endpoints

| Method | Path                                     | Purpose                         |
|--------|------------------------------------------|---------------------------------|
| POST   | `/orders`                                | Create order (+ items, confirm) |
| GET    | `/orders?status=`                        | List orders                     |
| GET    | `/orders/by-number/{n}`                  | Tracking lookup by order number |
| PATCH  | `/orders/{id}/status`                    | Update status (SMS customer)    |
| POST   | `/orders/{id}/assign`                    | Assign driver + compute route   |
| GET    | `/customers`                             | List/search customers           |
| POST   | `/customers`                             | Create customer                 |
| PUT    | `/customers/{id}`                        | Update customer                 |
| DELETE | `/customers/{id}`                        | Delete customer                 |
| GET    | `/ops/warehouses`                        | List warehouses                 |
| GET    | `/ops/vehicles`                          | List vehicles                   |
| GET    | `/ops/inventory`                         | List inventory                  |
| GET    | `/ops/payments`                          | List payments                   |
| GET    | `/ops/packages`                          | List packages                   |
| GET    | `/drivers/{id}/assignments`              | Driver fetches assignments      |
| PATCH  | `/drivers/assignments/{id}/status`       | Driver updates assignment       |
| POST   | `/drivers/gps`                           | Driver pushes a GPS ping        |
| POST   | `/drivers/pod`                           | Upload proof-of-delivery photo  |
| GET    | `/analytics/overview`                    | Dashboard summary cards         |
| GET    | `/analytics/cashflow`                    | Earnings overview               |
| GET    | `/analytics/admin-feed`                  | Notifications/messages/settings |
| POST   | `/tasks/daily-report`                    | Cron: email daily summary       |
| POST   | `/tasks/cleanup-gps`                     | Cron: prune old GPS rows        |
| GET    | `/shipments`                             | List parcels (all 4 tracks)     |
| POST   | `/shipments`                             | Register a parcel               |
| GET    | `/shipments/{id}/events`                 | Parcel audit trail              |
| PATCH  | `/shipments/{id}/status`                 | Move parcel status forward      |
| POST   | `/warehouse/scan/{id}`                   | Warehouse scan event            |
| GET    | `/warehouse/scans`                       | Scan history                    |
| GET    | `/warehouse/transfers`                   | Inter-warehouse transfers       |
| GET    | `/warehouse/handovers`                   | Driver ⇄ warehouse handovers    |
| GET    | `/driver-tasks`                          | Micro-driver task list (COD)    |
| GET    | `/trips`                                 | Big-driver trips                |
| GET    | `/trips/{id}/manifest`                   | Trip manifest + checkpoints     |
| GET/POST/PUT | `/vendors`                          | Business vendors (write: SA)    |
| GET    | `/settlements`                           | Vendor settlements list (staff)  |
| POST   | `/settlements`                           | Create settlement (super-admin)  |
| PATCH  | `/settlements/{id}/status`               | Advance settlement status (SA)   |
| GET    | `/settlements/cod`                       | COD collected at the door        |

Run tests: `pytest -q` (no Supabase needed for the suite).
Auth: `REQUIRE_AUTH=false` locally; set `true` + `SUPABASE_JWT_SECRET` in prod.

The backend uses the Supabase **service role** key and therefore bypasses RLS;
it is the trusted authority. Never ship the service key to a browser.

## Roles (BLA Logistics v2)

| Role | Access |
|------|--------|
| `super_admin` | Full control: vendors, staff, COD, settlements, reports, settings |
| `warehouse_admin` | Parcels: registration, scanning, transfers, handovers, assignments |
| `vendor` | Own shipments + COD only (RLS scopes to `vendor_id`) |
| `micro_driver` | Task updates only — **not** shown on the admin live map |
| `big_driver` | Inter-warehouse trips — shown on the admin live map |
| `customer` | Public tracking page; no dashboard |

Enforced two ways: **JWT role guards** in the API (`require_role`, `require_staff`,
`require_super_admin` — active when `REQUIRE_AUTH=true`) and **Postgres RLS**
policies in `db/schema.sql`. Dev mode (`REQUIRE_AUTH=false`) bypasses the guards
so local tooling keeps working. Vendor creation/update is super-admin only;
vendor list is staff-readable.

To upgrade an existing database: run `db/phase1_identity.sql` then
`db/phase1_seed.sql` (two separate executions).
