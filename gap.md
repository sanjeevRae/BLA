# BLA Logistics — Production Gap Analysis

**Status:** Security foundation complete (DB-authoritative roles, `/auth/me` gate, `/ops/profile` locked, `dev-bypass` removed).  
**Current state:** Basic auth + COD-only money flow.  
**Goal:** Production-revenue level — online payments, rate limiting, observability, multi-tenant scoping, CI/CD.

---

## 1. Online Payments (P0 — revenue blocker)

Money currently moves only via **COD (Cash on Delivery)** tracked in `settlements.py` + `cod_collections`. There is **no online payment capability** — customers cannot pay by card/wallet at checkout, and vendors cannot collect prepaid shipments.

### What exists
- `backend/app/routers/settlements.py` — COD gross/net calculations, settlement lifecycle (pending → settled).
- `backend/app/routers/orders.py` — order creation (no `payment_method` field).
- No Stripe / payment provider integration anywhere.

### What is missing
| Item | Details |
|------|---------|
| Payment provider SDK | `stripe` Python package not installed. |
| Config | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` missing from `config.py`. |
| PaymentIntent API | No endpoint to create a Stripe PaymentIntent for an order. |
| Webhook handler | No `POST /payments/webhook` to consume `payment_intent.succeeded` / `payment_intent.payment_failed`. |
| Order payment field | Orders have no `payment_method` (`cod` / `online`) or `payment_intent_id`. |
| Settlement linkage | `settlements` only sums `cod_collections`; online payments are invisible to finance. |
| Refunds | No refund endpoint or flow. |
| Frontend | Checkout flow has no card element / payment confirmation UI. |

---

## 2. Security & Auth (P1)

| Gap | Detail |
|-----|--------|
| Rate limiting | No per-IP / per-email limits on login or `/auth/me`. Brute-force possible. |
| Account lockout | No lockout after N failed attempts. |
| MFA / 2FA | Not implemented for admin/super_admin roles. |
| Session management | Supabase session only; no refresh-token rotation, no revocation list. |
| Audit logging | No immutable log of logins, role changes, failed attempts, payment events. |
| IP allowlisting | No CIDR restrictions for admin console. |
| SSO / OIDC | No enterprise SSO (Google Workspace, Entra, SAML). |
| JWT hardening | No signing-key rotation, no `kid`, relatively long-lived access tokens. |

---

## 3. Authorization & Multi-tenancy (P1)

| Gap | Detail |
|-----|--------|
| Fine-grained permissions | Role-based only (`super_admin`, `admin`, `vendor`). No per-resource permissions (`shipments:write`, `payments:refund`). |
| Resource scoping | Vendors can see own settlements, but no DB-level tenant enforcement across all tables. |
| Role hierarchy | Flat role list; no inheritance (e.g. `super_admin` inherits `admin`). |

---

## 4. API Hardening (P1)

| Gap | Detail |
|-----|--------|
| Input validation | Basic Pydantic schemas; missing max lengths, strict enums on all endpoints. |
| Error handling | Stack traces may leak; no standardized error envelope. |
| API versioning | No `/api/v1/` prefix. |
| Pagination | No `limit`/`offset` or cursor pagination on list endpoints. |
| Idempotency | No idempotency keys on payment/order creation (double-charge risk). |
| CORS | `allow_origins=["*"]` in dev; production needs exact domains. |
| Security headers | No HSTS, CSP, X-Frame-Options, nosniff. |

---

## 5. Database & Data Safety (P2)

| Gap | Detail |
|-----|--------|
| Migrations | Manual SQL (`phase3a_*.sql`, `phase3b_*.sql`); no Alembic/versioned migrations. |
| Backups | No automated DB backup or point-in-time recovery. |
| Soft deletes | Hard deletes on orders/shipments; no `deleted_at`. |
| PII encryption | Driver license, customer address, payment tokens not encrypted at rest. |
| Indexing | No indexes on `vendor_id`, `status`, `created_at` for query performance. |

---

## 6. Infrastructure & Observability (P2)

| Gap | Detail |
|-----|--------|
| Structured logging | `print`/basic logging; no JSON logs to ELK/Datadog. |
| Metrics | No Prometheus/Grafana; no latency or error-rate dashboards. |
| Tracing | No distributed tracing across order→dispatch→delivery. |
| Alerting | No PagerDuty/Slack alerts on 5xx spikes or DB outages. |
| CI/CD | Manual git push; no lint→test→build→staging→prod pipeline. |
| Zero-downtime deploys | No blue/green or rolling deploys. |
| Disaster recovery | No documented RTO/RPO or runbooks. |
| WAF / DDoS | No Cloudflare/AWS WAF in front of API. |

---

## 7. Revenue / Business Features (P2)

| Gap | Detail |
|-----|--------|
| Subscriptions / billing | No plans, metered usage, or proration. |
| Invoicing | No PDF invoice generation or tax calculation. |
| Driver payouts | No automated settlement/commission payouts to drivers. |
| Multi-currency | No FX or per-vendor currency. |
| Reporting / analytics | No executive dashboard (revenue, fulfillment rate, churn). |
| Export | No CSV/Excel/PDF export of shipments or invoices. |

---

## 8. Frontend Polish (P3)

| Gap | Detail |
|-----|--------|
| Error boundaries | No React error boundaries. |
| Loading / empty states | Basic; needs skeletons and retry buttons. |
| PWA / offline | No service worker for spotty driver connectivity. |
| Error reporting | No Sentry/LogRocket. |
| i18n / a11y | No multi-language or WCAG support. |

---

## Priority Order for Implementation

1. **P0 — Online Payments (Stripe)** ← *Starting now*
2. P1 — Rate limiting + account lockout
3. P1 — Multi-tenant resource scoping
4. P1 — API pagination + idempotency
5. P2 — Structured logging + metrics + alerts
6. P2 — Migrations (Alembic) + backups
7. P2 — Invoicing + driver payouts
8. P3 — Frontend polish
