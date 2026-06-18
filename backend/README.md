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
| PATCH  | `/orders/{id}/status`                    | Update status (SMS customer)    |
| POST   | `/orders/{id}/assign`                    | Assign driver + compute route   |
| GET    | `/drivers/{id}/assignments`              | Driver fetches assignments      |
| PATCH  | `/drivers/assignments/{id}/status`       | Driver updates assignment       |
| POST   | `/drivers/gps`                           | Driver pushes a GPS ping        |
| POST   | `/drivers/pod`                           | Upload proof-of-delivery photo  |
| GET    | `/analytics/overview`                    | Dashboard summary cards         |
| POST   | `/tasks/daily-report`                    | Cron: email daily summary       |
| POST   | `/tasks/cleanup-gps`                     | Cron: prune old GPS rows        |

The backend uses the Supabase **service role** key and therefore bypasses RLS;
it is the trusted authority. Never ship the service key to a browser.
