# BLA — User Guides

One guide per role. Everyone uses the **same login page** and the **same
system** — what differs is the dashboard you land on and what you are
permitted to do. Written for the system as specified; guides will be
verified against the built application in Phase 10.

## Logging in (everyone)

1. Open the BLA application and go to the **login page** — there is only
   one, for all roles.
2. Enter your email and password. Your account is created for you by an
   Admin (staff) or through vendor registration (vendors) — staff never
   create their own accounts, and there is no way to choose your own role.
3. You land directly on **your role's dashboard**. If you hold more than
   one responsibility (e.g. a rider who also does pickups), your dashboard
   shows all of it — permissions come from your account, not from which
   page you open.
4. If your login is refused, check the password first; repeated failures
   are rate-limited and monitored. If your account was suspended, only an
   Admin can reinstate it — you will not be able to log in until then.
5. Log out when you finish, especially on shared warehouse computers.

---

## Super Admin

**You land on:** the organization dashboard — every warehouse, all money,
all activity.

**Your most common tasks:**
- **See the whole operation:** Overview shows totals for orders, packages in
  every state, warehouses, drivers, vehicles, vendors, revenue, outstanding
  charges and COD positions. Use the filters (date, warehouse, status,
  vendor, driver) to narrow in.
- **Manage administrators and warehouses:** Users and Roles for admin
  accounts; Warehouses to create a warehouse, assign its Warehouse Admin
  and staff.
- **Approve sensitive finance:** COD discrepancies, large adjustments and
  vendor settlements that require your approval arrive in Finance /
  Settlements with the full history attached — approve or reject with a
  reason.
- **Configure the system:** Settings holds service areas, pricing rules,
  status rules and notification settings. Changes are audit-logged.
- **Check the audit log:** Audit Logs shows who did what, including your
  own actions. Use it whenever a number or a record is questioned.

## Admin / Operations Admin

**You land on:** the company operations dashboard — same overview as Super
Admin, without organization-security settings.

**Your most common tasks:**
- **Run the day:** Overview → check pending pickups, in-transit transfers,
  open exceptions; resolve anything unassigned.
- **Create bookings and assign riders:** Orders → New Booking (or approve a
  vendor's booking), then Assignments to give pickups/deliveries to riders
  by area and workload.
- **Manage drivers and vehicles:** Drivers → add/verify/activate drivers;
  Trips and Vehicles → plan line-haul trips, assign driver + vehicle.
- **Approve vendors and transfers:** Vendors → review registrations and
  approve; Transfers → approve manifests and monitor arrivals.
- **Create tasks:** Tasks → assign work to warehouse staff, drivers,
  finance or support, with priority and deadline; review submissions.

## Warehouse Admin

**You land on:** your warehouse's dashboard — only your warehouse
(e.g. Kathmandu). You cannot see other warehouses' inventory, and they
cannot see yours.

**Your most common tasks:**
- **Receive incoming transfers:** Transfers → Incoming → open the manifest,
  scan each package as it is unloaded, record damaged/missing on the spot.
  Confirm receiving only for what physically arrived; the system reconciles
  the counts for you.
- **Run the floor:** Inventory shows every package in your warehouse and
  its storage location. Watch "awaiting sorting" and "awaiting dispatch"
  queues and assign staff tasks to clear them.
- **Dispatch transfers:** Transfers → New → select packages from your
  inventory, prepare the manifest, assign the line-haul driver/vehicle,
  confirm loading scans and dispatch.
- **Assign local deliveries:** Assignments → give ready packages to your
  riders by delivery area; receive back undelivered packages at day end.
- **Watch capacity and discrepancies:** your dashboard warns as capacity
  fills; inventory discrepancies appear until resolved through an incident.

## Warehouse Staff / Operator

**You land on:** your task dashboard — your assigned work and the scanning
queues for your warehouse.

**Your most common tasks:**
- **Receive packages:** open the receiving queue, scan each package's
  QR/barcode, verify the tracking ID on screen matches the label, record
  weight and condition. If it is damaged or doesn't match, record it right
  there — the system creates the incident.
- **Put away and move:** after receiving, the system shows the storage
  location (e.g. `ZONE-A / RACK-03 / SHELF-02`). Scan again when you move a
  package to a different rack — internal moves are recorded, not transfers.
- **Sort and prepare dispatch:** work the sorting queue by destination;
  when a transfer is being loaded, scan every package onto the vehicle.
- **Work your tasks:** Tasks lists what your Warehouse Admin assigned you.
  Accept, work, and submit with a comment or photo evidence when asked.
- **Report problems immediately:** missing package, wrong package,
  suspicious package — use "Report issue" on the package. Reporting is
  always the right move; guessing is not.

*Scanning the same package twice is safe — the system recognizes the
duplicate and tells you, without creating a second record.*

## Delivery Rider

**You land on:** your rider dashboard — today's pickups and deliveries
assigned to you, and nothing else. You only ever see your own work.

**Your most common tasks:**
- **Pickups:** open the pickup, check the sender and address, tap to
  navigate/contact. On arrival, scan the package, check its condition
  matches the booking, confirm collection. If the sender isn't there or the
  package isn't ready, record a failed pickup with the reason.
- **Deliveries:** before leaving the warehouse, scan your packages and
  confirm **Out for Delivery**. At the door: hand over, collect the OTP
  from the recipient (or signature/photo where used), and confirm delivery.
- **COD:** if the delivery is cash-on-delivery, the amount is shown on the
  delivery. Collect it, record the amount and method (cash/wallet) exactly
  as collected — this record is what Finance reconciles against, so never
  round it or fix it later.
- **Failed deliveries:** recipient unavailable, phone unreachable, refused,
  wrong address — record the attempt with the reason. The system notifies
  the customer and schedules the next step; an unrecorded failure looks
  like the package vanished.
- **End of day:** return undelivered packages to the warehouse (they are
  scanned back in) and hand over the day's COD. Your dashboard shows COD
  collected vs pending remittance so you always know your position.

*No signal? Keep working — your completed actions queue on the phone and
sync when you are back online. Don't re-enter them.*

## Line-Haul (Warehouse-to-Warehouse) Driver

**You land on:** your trip dashboard — your assigned trips, vehicle and
manifests.

**Your most common tasks:**
- **Start a trip:** open the assigned trip, check the manifest and the
  vehicle. During loading, every package is scanned — confirm the loaded
  count matches before you confirm departure.
- **On the road:** update trip progress at checkpoints. Report delays,
  breakdowns or accidents from the trip screen immediately — dispatch sees
  it and can arrange help or a replacement vehicle.
- **Arrive and hand over:** record arrival; the receiving warehouse scans
  the packages off. Stay until the counts are confirmed — if they received
  fewer than you carried, that becomes a discrepancy on the record, and
  your confirmed loaded count is your protection.
- **Trip history:** past trips, manifests and handovers stay visible to
  you under Trips.

*You cannot change the manifest after dispatch or mark packages received
yourself — receiving is always the destination warehouse's scan.*

## Vendor

**You land on:** your vendor dashboard — your bookings, your packages, your
money. You can never see another vendor's data.

**Your most common tasks:**
- **Create a booking:** Bookings → New. Add the recipient, delivery
  address, package description, quantity, declared weight/dimensions,
  choose the service, pickup-from-office or warehouse drop-off, and prepaid
  or COD. Submit — the system generates the tracking IDs and labels.
- **Track your shipments:** Shipments lists every package with its current
  status; open one for its full public history, delivery attempts and
  proof of delivery where policy permits.
- **Follow your money:** Finance shows invoices and shipping charges, COD
  collected on your deliveries, COD pending, and your settlement history
  and outstanding balance. Download statements for your accounts.
- **Manage your business:** keep pickup addresses current; if your account
  shows "under review" or "suspended", contact BLA — verification documents
  are managed from your Account page.
- **Raise a dispute:** on any charge or settlement, use "Raise dispute"
  with the reference — it goes to Finance with the transaction attached.

*If several people in your business use BLA, an Admin can add them under
your vendor account as Manager, Booking Staff or Accounts Staff — each with
their own login, all seeing only your business's records.*

## Finance / Accounts Staff

**You land on:** the finance dashboard — revenue, charges, COD positions,
driver cash balances, unreconciled transactions.

**Your most common tasks:**
- **Record and verify payments:** Payments → record cash/bank/wallet
  payments against invoices, verify references before confirming. A payment
  submitted twice is detected — you will see the original, not a duplicate.
- **Daily COD reconciliation:** COD Management → compare each rider's
  collected vs remitted for the day. Matches reconcile in one action; a
  shortfall opens a discrepancy that blocks settlement of the missing
  amount until resolved (see the Operations Manual, §4).
- **Vendor settlements:** Settlements → generate from the ledger (COD held
  − shipping charges − authorized deductions), review, and approve or send
  for Super Admin approval where required. Record the payout against the
  settlement.
- **Refunds and adjustments:** always create a linked adjustment/reversal —
  the original transaction is never edited. Give a reason; adjustments are
  audit-logged.
- **Reports:** Finance reports (revenue, outstanding, COD reconciliation,
  settlements) are generated from the same ledger you work in — if a report
  looks wrong, the underlying transaction is where the answer is.

*You cannot change package custody or delivery status — if a financial
record depends on a delivery fact, ask Operations to correct the operation;
the money follows the record.*

## Customer Support Staff

**You land on:** the support dashboard — open complaints, missing-package
reports, failed deliveries, address-correction requests, overdue cases.

**Your most common tasks:**
- **Find a package fast:** search by tracking ID, phone or order number to
  see the authorized tracking view — current status, attempts, and history.
- **Work complaints:** open the ticket, contact the recipient or vendor
  from the case, add notes as you go. Every conversation about a case
  belongs on the case.
- **Fix address problems:** for "address clarification required" packages,
  contact the recipient, record the corrected address through the
  correction process (it routes for approval — you don't edit the shipment
  directly), and request redelivery.
- **Escalate investigations:** missing or damaged packages become incidents
  assigned to the warehouse/Admin — create the investigation task from the
  case so it has an owner.
- **Close cases properly:** close only after the required verification
  (delivered confirmed, refund issued, address corrected). The customer
  gets the resolution notification.

*You cannot change payments or package custody — if a case needs either,
escalate to Finance or Operations from the case rather than working around
it.*

## Customer / Recipient (no account needed)

**You use:** the public **tracking page** — no login, no account.

**How it works:**
1. Enter your **tracking ID** (on your receipt/SMS) and the **phone number**
   the delivery is addressed to.
2. See your package's current status, where it is (city/warehouse level),
   the estimated delivery window, and its journey so far.
3. When the rider is on the way, you'll get a notification. If a delivery
   attempt fails, the page shows what happens next (redelivery or pickup).
4. If the rider asks for an **OTP**, it is the code sent to your phone —
   give it only to the rider at your door, at the moment of delivery.
5. Problem — package late, damaged, or marked delivered but not received?
   Use **Contact Support** on the tracking page; your report goes straight
   to the support team with your package attached.
