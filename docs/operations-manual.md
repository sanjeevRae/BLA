# BLA — Operations Manual

Day-to-day running of the BLA logistics platform for Admins, Warehouse
Admins and Finance staff. Written for the system as specified; procedures
will be verified against the built application in Phase 10.

**Golden rules (apply all day, every day):**
- A package's location changes only through a recorded movement — never by
  editing a record to "fix" it.
- Money is corrected only through linked adjustments — never by editing a
  payment.
- If the physical world and the system disagree, the physical count wins
  and the difference becomes a discrepancy/incident — never a silent edit.

---

## 1. Starting the day / opening a shift

**Warehouse Admin (each warehouse, e.g. Kathmandu `WH-KTM-01`):**
1. Log in and open your warehouse dashboard. Confirm the overnight figures:
   packages in warehouse, incoming transfers expected today, packages
   awaiting sorting/dispatch, damaged/missing items still open.
2. Check **Exceptions and Incidents** for anything assigned to your
   warehouse that is unresolved — yesterday's shortage is today's first job.
3. Check **Tasks** for overdue items and reassign or escalate before the
   shift starts moving packages.
4. Confirm rider availability for today (available / on leave / suspended)
   and vehicle availability for scheduled line-haul trips.
5. Check the **capacity indicator**: if the warehouse is near its configured
   limit, plan dispatches early (see §5).

**Admin / Operations:**
1. Open the Overview dashboard: pending pickups, in-transit transfers,
   out-for-delivery counts, open exceptions across all warehouses.
2. Review trips scheduled today — any trip without an assigned driver or
   vehicle gets resolved before departure time, not after.
3. Review new vendor registrations awaiting verification.

## 2. Monitoring during the day

- **Overview dashboard** (Admin/Super Admin): packages per state, delivered
  today, failed attempts, COD pending collection and awaiting settlement.
  Figures are live from real records — if a number looks wrong, drill into
  the module; do not "correct" it anywhere.
- **Transfers in transit:** watch expected arrival times. A trip that passes
  its expected arrival without an arrival scan is a delay — contact the
  driver, and if unreachable, open an incident (delayed shipment) so the
  delay is on record.
- **Failed delivery attempts:** a rising count for one rider or one area
  usually means an address-data problem, not a rider problem — Support
  checks the addresses before Finance or Admin questions the rider.
- **Notifications panel:** capacity warnings, transfer discrepancies,
  missing-package alerts, overdue tasks and COD discrepancies arrive here
  and as dashboard badges. Treat a discrepancy notification as a task, not
  as information.

## 3. Handling incidents

All operational problems live in **Exceptions and Incidents** — not in chat
messages or notebooks.

1. **Report** (any staff member): choose the category (missing package,
   damaged package, transfer shortage/excess, wrong warehouse, delivery
   failure, COD discrepancy, vehicle breakdown, …), link the package /
   transfer / trip, describe what physically happened, attach photo evidence
   where relevant.
2. **Acknowledge & assign:** the responsible Warehouse Admin or Admin
   acknowledges, assigns an owner and a severity. A missing package stays an
   open discrepancy in inventory until the investigation concludes — it is
   never written off by removing the record.
3. **Investigate:** notes go on the incident record (who checked what,
   where). For transfer shortages, the manifest, the loading scans and the
   line-haul driver are linked automatically — start there.
4. **Resolve:** resolution requires the outcome (found / confirmed lost /
   compensated / corrected transfer) and, where configured, approval.
   Resolution closes the incident; the record stays readable forever.
5. **Escalate** instead of sitting on it: anything unresolved at end of day
   is escalated to Admin; anything involving money (COD discrepancy,
   payment dispute) is escalated to Finance the same day.

**Breakdown/accident on a trip:** the driver reports it from the trip
dashboard; dispatch is notified automatically. Admin arranges the
replacement driver/vehicle, and the handover between drivers is recorded as
a custody transfer — packages are never "just moved" to another vehicle.

## 4. COD end-of-day reconciliation routine

Cash on delivery is the highest-risk routine in the business. It runs
**every operating day**, per warehouse, before the day is closed.

1. **Riders submit:** each delivery rider's collected COD (per package,
   recorded at delivery time) is totalled by the system as "COD collected".
   The rider physically hands over cash / submits remittance evidence.
2. **Warehouse/Admin counts:** the receiving officer counts the physical
   cash and records the **remittance** amount against the rider for the
   day. The system compares collected vs remitted automatically.
3. **Match → reconcile:** if the amounts match, Finance (or Admin with
   finance permission) marks the day's remittances reconciled. The amounts
   move to "COD awaiting settlement" per vendor.
4. **Mismatch → discrepancy, same day:** if a rider collected Rs. 5,000 and
   remits Rs. 4,500, the original Rs. 5,000 collection record stays as-is,
   the Rs. 4,500 remittance is recorded, and the system shows a **Rs. 500
   discrepancy** and opens a finance incident. The missing Rs. 500 is
   blocked from vendor settlement until the incident is resolved. Nobody
   edits the collection figure to make the day balance.
5. **Vendor settlements:** Finance generates settlements from the ledger
   (COD held for the vendor − shipping charges − authorized deductions).
   Settlements require approval per the permission matrix before payment is
   recorded. A settlement is never calculated from a hand-kept total.
6. **Unreconciled list:** anything left in "COD awaiting remittance" or
   "unreconciled transactions" at day end is reviewed by Finance the next
   morning — it is the first finance task of the day, not the last.

## 5. Capacity warnings

- The warehouse dashboard shows capacity usage against the configured limits
  (package count / zone / weight). Approaching the limit raises a warning
  to the Warehouse Admin and Admin.
- On a warning: prioritize dispatch of ready packages, and notify Admin
  before accepting a large inbound transfer.
- At the **hard limit**, the system blocks further acceptance. Packages are
  rerouted by Admin to another warehouse through a proper transfer — they
  are never marked "received" at a warehouse that does not physically hold
  them.

## 6. Suspending a user (with custody reassignment)

Used for staff who leave, are suspended, or lose a device. Done by Admin /
Super Admin in **Users and Roles**.

1. Open the user, choose **Suspend**, give a reason (required, audit-logged).
   Suspension takes effect immediately: the account cannot log in and any
   existing session is revoked.
2. **Custody check (mandatory):** if the user currently holds packages
   (rider with undelivered parcels, staff member mid-task, driver on a
   trip), the system lists them. Each package/task must be reassigned to a
   named colleague — the reassignment is recorded as a custody handover, so
   the chain of accountability has no gap.
3. The responsible Warehouse Admin is alerted automatically and confirms
   the physical handover of the packages.
4. The suspended user's history (scans, deliveries, tasks, financial
   actions) remains fully visible in audit logs and package histories —
   suspension never erases accountability.
5. Reinstatement (if applicable) is a separate, deliberate action by an
   Admin, also audit-logged.

## 7. End of day

**Warehouse Admin:** confirm all received packages are scanned into storage
locations (no package "in the building but not in the system"), all
dispatched transfers have departure confirmed, undelivered packages from
riders are received back and recorded, and open incidents are updated or
escalated.

**Finance:** complete the COD routine (§4); check the unreconciled list is
empty or carried over with an owner.

**Admin:** glance at tomorrow's scheduled trips and pickups; until automated
backups are configured, take the daily database backup
(`docs/backup-and-recovery.md` §2).

## 8. When something is wrong with the system itself

- Login or dashboard errors affecting everyone: check the deployment status
  (Vercel) and database status (Supabase) dashboards first; if the database
  is implicated, **do not** attempt ad-hoc fixes in the SQL editor on live
  data — raise an incident, and restore only per
  `docs/backup-and-recovery.md`.
- Suspected unauthorized access (logins you don't recognize, audit-log
  denials from a warehouse user probing another warehouse): suspend the
  account (§6), then investigate from the audit log. The log is the record;
  do not delete or edit it.
