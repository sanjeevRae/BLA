# BLA Vendor portal

Static page for the **Business Vendor** role:

- **Register parcel** — `POST /shipments` (the backend stamps `vendor_id` from
  the vendor JWT automatically).
- **My parcels** — `GET /shipments`, server-side scoped to the signed-in
  vendor's own rows (a vendor can never read another vendor's parcels).
- **Settlements** — `GET /settlements`, also auto-scoped to the own vendor id.

## Run locally

```bash
npx serve .        # open http://localhost:3000
```

`config.js` mirrors `admin-dashboard/.env`. Sign in with a Supabase Auth user
whose `users.role = vendor` and `users.vendor_id` set. On a local backend with
`REQUIRE_AUTH=false`, **Continue without login (dev only)** works (sees all
rows — scoping only applies with a real vendor JWT).
