# `app/models/`

The **source of truth for the data model is `db/schema.sql`** (raw PostgreSQL,
applied to Supabase). This backend talks to Supabase via the `supabase-py`
client rather than an ORM, so there are no SQLAlchemy table classes here.

Instead, the request/response shapes live in [`app/schemas/`](../schemas) as
Pydantic models. This module is kept as a deliberate placeholder so the package
layout matches the conventional FastAPI structure and so you have an obvious
home for ORM models *if* you later introduce SQLAlchemy/SQLModel (e.g. for
complex transactional logic that is awkward through the REST client).
