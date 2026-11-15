# Exception and Incident Management — BLA Logistics Platform

**Purpose.** Real logistics fails daily: packages go missing, arrive damaged,
land at the wrong warehouse, money doesn't add up. This module gives every
such problem a record, an owner, a workflow and a resolution — instead of a
phone call and a quietly edited status. Spec reference: Part 16; Part 23
scenario mapping in §5.

**Design principle:** an exception is a *layer on reality*, never a rewrite of
it. Raising an incident never deletes inventory, never changes a package's
operational status history, and never adjusts money. It flags, assigns and
tracks until a human resolves it through the proper operational or financial
action.

---

## 1. Incident categories

| Category | Typical trigger | Default severity |
|---|---|---|
| `missing_package` | Custody gap, failed handover, not found at audit | Critical |
| `damaged_package` | Inspection, receiving, rider report, recipient report | High |
| `wrong_warehouse` | Misroute scan at an unintended warehouse | High |
| `wrong_package_received` | Unmanifested/unknown package received | Medium |
| `transfer_shortage` | Destination receives fewer than manifested | High |
| `transfer_excess` | Destination receives more than manifested | Medium |
| `delivery_failure` | Attempt-limit reached / repeated failures | Medium |
| `customer_refusal` | Recipient refuses (also starts return flow) | Low |
| `incorrect_address` | Address clarification unresolved | Medium |
| `pickup_failure` | Repeated failed pickups | Medium |
| `driver_breakdown` | LD/DR reports vehicle breakdown | High |
| `vehicle_accident` | Any accident report | Critical |
| `theft_suspicion` | Custody break with loss indicators | Critical |
| `cod_discrepancy` | Remittance ≠ collections | High |
| `payment_dispute` | Vendor/customer disputes a charge or settlement | Medium |
| `duplicate_booking` | Same consignment booked twice | Medium |
| `duplicate_scan` | Repeated idempotency collisions from one actor (pattern, not single event) | Low |
| `weight_discrepancy` | Actual vs declared weight beyond tolerance | Low |
| `delayed_shipment` | SLA/ETA breach thresholds | Medium |
| `customer_complaint` | Support case from recipient/vendor | Medium |
| `unauthorized_access_attempt` | Cross-scope request denied by the authorization layer | High |

Severity is a default; the reporter or triaging manager can raise (not
silently lower) it.

## 2. Incident record

`incidentId` · category · severity (`low`/`medium`/`high`/`critical`) ·
related package / order / shipment / transfer / trip (whichever apply) ·
reporting user (DB-resolved; system-generated incidents name the detecting
process and the triggering records) · responsible team (warehouse / finance /
support / operations) · warehouse · description · evidence (photos/documents
in private storage) · investigation notes (append-only thread) · resolution
(text + the operational/financial action taken) · approval (where the
resolution moves money or writes off a package) · status (§3) · created /
acknowledged / resolved / closed timestamps.

## 3. Incident workflow

`reported` → `acknowledged` → `assigned` → `investigating` →
`awaiting_information` (when blocked on a person) → `escalated` (severity or
age breach) → `resolution_proposed` → `resolution_approved` → `resolved` →
`closed`.

Rules:
- **Acknowledgement SLA** by severity (critical: immediate notification to
  AD/SA + responsible WA; high: same shift; medium/low: next business day —
  thresholds are settings).
- **Auto-escalation:** an incident that sits unacknowledged or unresolved
  past its SLA escalates one level (WA → AD → SA) with notification. Nothing
  ages silently.
- **Resolution approval:** resolutions that write off a package, waive
  charges, or post financial adjustments require AD/SA approval and execute
  through the relevant service (finance adjustment, custody correction) —
  the incident records the resulting transaction/record IDs.
- **Closure check:** an incident cannot close while its linked operational
  facts are unresolved — e.g. a `transfer_shortage` cannot close while the
  transfer still shows unaccounted packages, unless the resolution is an
  approved loss write-off.

## 4. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Report an incident | All staff; vendors/recipients for own packages | `incident.report` |
| Triage, assign, investigate | AD/SA all; WA own warehouse; FN finance categories; SP customer-facing categories | `incident.manage` (scoped) |
| Propose/approve resolution | Investigator proposes; AD/SA approve money/loss resolutions | `incident.resolve` (scoped) |
| View | Scoped like manage; vendors see only the customer-safe summary of incidents on own packages | — |

Support creates and manages customer-facing incidents but cannot change
custody or money from inside an incident — they request, operators and
finance execute (role-permission-matrix.md §3.8).

## 5. How the spec's Part 23 scenarios map to incidents

| Scenario | Incident | Automatic behaviour |
|---|---|---|
| **S1 — Missing package in transfer** (50 dispatched, 48 received) | `transfer_shortage` + `missing_package` per missing package | 48 packages complete receiving normally; 2 stay in driver custody in the system; transfer blocked from reconciliation; AD + both WAs notified; driver + manifest linked |
| **S2 — Wrong warehouse** (Pokhara parcel reaches Chitwan) | `wrong_warehouse` | Arrival scan records an observation only; package quarantined with `misrouted` exception; it does **not** enter Chitwan inventory; corrective transfer created; full movement history preserved |
| **S3 — Damaged package received** | `damaged_package` | Condition + photos + receiving employee recorded; package to Damaged zone, on hold if needed; vendor/AD notified per severity; resolution recorded on the incident |
| **S4 — Customer unavailable** | *(no incident by default)* | Attempt recorded with reason + timestamp; attempt count increments; recipient notified; redelivery or return per policy. Escalates to `delivery_failure` incident only at the attempt limit |
| **S5 — COD mismatch** (collected Rs. 5,000, remitted Rs. 4,500) | `cod_discrepancy` (finance) | Original collection (5,000) and remittance (4,500) both preserved; Rs. 500 shown as discrepancy; that amount excluded from vendor settlement until resolved; investigation + resolution on the incident (cod-reconciliation.md §3) |
| **S6 — Driver breakdown** | `driver_breakdown` on the trip | Trip preserved with incident overlay; dispatcher notified; authorised reassignment with recorded load handover; ETA updated |
| **S7 — Duplicate scan** | *(no incident for a single event)* | Idempotency key absorbs the duplicate; operator sees "already recorded"; a *pattern* of collisions from one account raises `duplicate_scan` for WA review |
| **S8 — Simultaneous actions on one package** | *(no incident)* | Transaction lock/version check rejects the second action as a conflict; no duplicate custody. Repeated conflicts from one account are audit-flagged |
| **S9 — Vendor cancels after pickup** | *(workflow, not incident)* | Ordinary cancellation rejected; cancellation/return workflow starts; charges calculated; history maintained |
| **S10 — Offline delivery** | *(no incident unless conflict)* | Queued actions sync with original timestamps; conflicting updates stored as observations and flagged for dispatcher review |
| **S11 — Unauthorised warehouse access** (Warehouse A user probes Warehouse B) | `unauthorized_access_attempt` | Server rejects the request; attempt audit-logged without exposing B's data; repeated probes notify AD/SA |
| **S12 — Duplicate financial request** | *(no incident)* | Idempotency: one transaction, original result returned |
| **S13 — Partial shipment delivery** (3 of 5 delivered) | *(no incident)* | Normal per-package states; shipment shows partially fulfilled; COD/charges per delivered package |
| **S14 — Driver reassignment** | *(workflow, not incident)* | Authorised reassignment with both custody legs recorded; history shows both riders |
| **S15 — Return to sender** (refusal) | `customer_refusal` (low) + return record | Refusal reason recorded; authorised return created; every handover tracked; vendor notified; return charges per policy |
| **S16 — Warehouse capacity reached** | `delayed_shipment`/capacity incident at hard limit | Capacity warning displayed; dispatch/receiving into the warehouse flagged or blocked per rules; authorised rerouting offered; packages never falsely marked received |
| **S17 — Staff account disabled while holding packages** | `missing_package` risk case opened per unaccounted item if handover fails | Sessions revoked immediately; responsible admin alerted; custody reassignment required item-by-item; all historical activity preserved |

## 6. Missing-package doctrine (spec §16.3)

A missing package is **never removed from inventory by an incident**. It
remains an unresolved discrepancy — visible in the warehouse's discrepancy
list, in the transfer's unaccounted list, and in reports — until an
authorised investigation concludes with one of: found (normal flow resumes,
custody corrected by handover), or declared lost (AD/SA-approved resolution;
package moves to terminal `lost` exception state with the full record kept;
vendor claim process starts). The inventory record closes only through one
of those two outcomes.

## 7. Notifications

Incident creation and escalation notify by category routing: warehouse
incidents → WA of the warehouse + AD; finance incidents → FN + SA (critical);
customer-facing → SP queue; critical severity → SA + AD immediately. All
notifications are in-app first, generated from the incident event (no
duplicates on retry — notification creation is idempotent per incident
event).

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Incident raised without a resolvable owner (e.g. warehouse has no active WA) | Routes to AD queue and is flagged "unowned" on the AD dashboard until assigned |
| Resolution proposed that requires a financial adjustment | Blocked until the linked adjustment is approved and posted; incident stores the adjustment ID |
| Attempt to close a shortage incident with packages still unaccounted | Refused; closure requires the loss write-off path with AD/SA approval |
| Evidence upload fails / wrong file type | Upload rejected with reason; incident remains open without evidence — damage incidents cannot be *resolved* without at least one evidence item or an SA override with reason |
| Reporter is the subject of the incident (e.g. rider reports own shortage) | Permitted and encouraged (self-reporting is a good sign); triage assignment excludes the reporter from investigating their own incident |
| Duplicate incident for the same event (auto + manual) | Triage can merge: the duplicate closes as `merged into #ID`, preserving both records |
