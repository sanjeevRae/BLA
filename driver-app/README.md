# BLA Driver app

Static mobile-first PWA-style page for the two driver roles:

- **Micro drivers** — task list from `/driver-tasks` with the task status track
  (accept → picked up → out for delivery → delivered / failed), COD collection
  input at the door.
- **Big drivers** — active trip from `/trips` with the trip status track,
  checkpoint logging, cancel.
- **GPS toggle** — streams position to `/drivers/gps` every few seconds. Big
  drivers show up on the admin live map; micro drivers intentionally do not.

## Run locally

```bash
npx serve .        # or any static server; open http://localhost:3000
```

`config.js` mirrors `admin-dashboard/.env` (Supabase URL + anon key,
`API_BASE_URL`). Sign in with a Supabase Auth user whose `users.driver_id`
profile exists (`drivers.user_id = auth user id`). On a local backend with
`REQUIRE_AUTH=false` you can use **Continue without login (dev only)**.

## Status actions

All actions call the backend (JWT Bearer when signed in):

| Action | Endpoint |
|--------|----------|
| Task advance / COD | `PATCH /driver-tasks/{id}/status?status=&cod_collected=` |
| Trip advance | `PATCH /trips/{id}/status` |
| Checkpoint | `POST /trips/{id}/checkpoints` |
| GPS ping | `POST /drivers/gps` |
