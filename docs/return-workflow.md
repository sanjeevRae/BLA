# Returns and Reverse Logistics — BLA Logistics Platform

**Purpose.** A return is a first-class workflow, not a status edit: the
package travels back through the network with its own authorisation, charges,
custody chain and tracking, while the original delivery history stays intact.
Spec reference: Part 12; Scenarios 9 and 15.

---

## 1. When a return starts

| # | Trigger | Initiated by |
|---|---|---|
| 1 | Recipient refuses delivery | Rider records refusal; WA/AD creates the return |
| 2 | Recipient unreachable after attempt limit | WA decision at attempt-limit review |
| 3 | Incorrect/incomplete address, unresolvable | WA after address-clarification exception fails |
| 4 | Vendor requests return | Vendor (`package.return_initiate`, own shipments) → WA/AD approves |
| 5 | Package damaged (unsafe/unacceptable to deliver) | WA on inspection/incident outcome |
| 6 | Package undeliverable (area, closure, force majeure) | WA/AD |
| 7 | Cancellation after pickup (Scenario 9) | Vendor/customer request → converted to return; ordinary cancellation is **rejected** once the package is in custody |
| 8 | Return otherwise authorised | AD/SA with reason |

Every return requires an **authorisation step**: requests (vendor, recipient,
support) land in a WA/AD queue; approval creates the return record with the
authoriser, reason and charge decision attached.

## 2. Return record

Linked to the original order/shipment/package (never a replacement for them):

`returnId` · original package/shipment · reason (from §1) · requestedBy ·
authorisedBy · authorisation time · return charges (amount + who bears them:
vendor, recipient, or company, per policy and reason) · package condition at
initiation · current return state · final receiving party · full custody chain
(shared with the package's tracking history).

## 3. Workflow

| # | State | What happens |
|---|---|---|
| 1 | `return_requested` | Request recorded with reason; package flagged so it cannot be re-dispatched for delivery |
| 2 | `return_approved` | WA/AD approves (or rejects with reason → package returns to normal flow, flag cleared, request kept in history) |
| 3 | `return_collection_assigned` | Collection path set: rider brings it back from the door (refusal case — already with rider), recipient drops at warehouse, or a pickup is assigned |
| 4 | `collected_for_return` | Package scanned into the return chain; custody recorded; if it must travel between warehouses it joins a normal transfer as a manifested package flagged as a return |
| 5 | `return_in_transit` | Moving toward the return warehouse (origin warehouse by default, or the vendor-designated return point) |
| 6 | `received_at_return_warehouse` | Receiving scan into the **Returns zone**; inventory record opens with condition noted |
| 7 | `return_inspected` | WA/WS inspect: condition vs original dispatch condition, contents check where authorised; damage found here links to the incident record |
| 8 | `return_completed` | Final handover: package handed to the vendor/sender (handover confirmed by vendor receipt, counter signature, or dispatched back to vendor address) |
| 9 | `vendor_notified` | Notification sent at approval, at return-warehouse receipt, and at completion, with the charge summary |

States `return_requested`/`return_approved` can also end as
`return_cancelled` (e.g. recipient accepts a redelivery instead) — recorded,
never deleted.

## 4. Charges and finance

- Return charges follow the tariff/policy for the reason: e.g. refusal and
  failed-delivery returns are normally billable to the vendor; company-error
  returns (misroute, our damage) are borne by the company; the decision is
  recorded on the return at authorisation and can be adjusted only by a
  linked finance adjustment (financial-workflow.md), never by editing.
- If the original shipment was prepaid, any refund is a finance workflow
  (`refund.process`) referencing the return — the return itself moves no
  money.
- COD shipments that were never delivered have no COD event; if COD was
  collected and the recipient then returns the goods through an authorised
  channel, the refund path handles the money with the return as evidence.

## 5. Exchanges and replacements

An exchange is **two linked shipments**, not a transformation of one: the
return (this workflow) plus a **new booking/shipment** created by the vendor,
cross-linked (`replacementForShipmentId` / `returnId`). The replacement
follows the normal lifecycle from `booked`; the original's history is
untouched. This keeps tracking, charges and COD correct on both legs.

## 6. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Request return | Vendor (own), recipient (verified), support | `package.return_initiate` (scoped) |
| Approve/reject, set charges | WA (own warehouse), AD/SA | `package.return_initiate` + approval is WA/AD per matrix |
| Collect / transport | Assigned DR, LD via transfers | `pickup.confirm`, transfer permissions |
| Receive + inspect at return warehouse | WA/WS | `package.receive`, `package.inspect` |
| Complete (vendor handover) | WA/WS with vendor confirmation | `custody.handover` |
| Refund handling | Finance | `refund.process` |

## 7. Rules and invariants

1. **History is never erased.** The original booking, attempts, and delivery
   failure remain exactly as recorded; the return appends its own chain.
2. A package under an approved return cannot be assigned for delivery again;
   the flag clears only via `return_cancelled` or completion.
3. Custody is continuous through the return — rider → warehouse → (transfer)
   → return warehouse → vendor — with confirmed handovers at each leg.
4. Condition is recorded at initiation and again at return inspection;
   deterioration between the two raises an incident automatically.
5. Return charges are decided at authorisation and visible to the vendor on
   their statement; surprises at settlement time are a process bug, not a
   negotiation.
6. One active return per package. A second request while one is open is
   refused and pointed at the open return.

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Vendor cancels after pickup via the normal cancel action | Rejected with explanation; the return path is offered and, if accepted, created as a return with charges calculated (Scenario 9) |
| Recipient refuses but rider already left without the package | Return collection is assigned as a pickup; if the recipient then refuses collection, incident + support case; package state stays truthful throughout |
| Package damaged during return transit | Condition update + incident at the next scan point; liability investigation uses the custody chain |
| Vendor never collects the completed return | After a configured grace period, storage-fee policy applies and AD is notified; the package is never discarded or absorbed into stock by the system |
| Return arrives at the wrong warehouse | Misroute handling: quarantined, corrective transfer created (transfer-workflow.md §5) |
| Duplicate return request (vendor + support) | Second request is refused and linked to the open return |
