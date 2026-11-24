# Plan — several POs from one customer account, Outlook to SAP

**Ask (Suraj, 24 Nov):** finish the flow from Outlook to SAP, and support the *multiple PO* handling Zarrar has built on the SAP side, so that several POs from the same customer account arrive, are organised together in the Business Command Centre, and go to SAP as one complete flow.

---

## 1. Where things stand today

| Area | What already works | What is missing for this request |
|---|---|---|
| Outlook intake (`services/mailIntake/intake.ts`) | One email → up to 50 PDFs → **one record per PDF**, linked to an `IntakeEmail`. Sender allow-list, retry-safe, notifications. | Nothing says which **customer account** a PO belongs to. Two emails from the same customer are unrelated records. |
| Data model (`schema.prisma`) | `POHeader.customerName` / `customerCode` as read by OCR. | No `CustomerAccount` entity. OCR text varies ("APEX FASTENER SUPPLY INC." vs "Apex Fastener Supply"), so you can't group on it reliably. |
| Worklist | Flat list, filtered by status, with the sender address on emailed rows. | No account view, no grouping, no way to filter or bulk-approve one customer's POs. |
| Dashboard | Totals for 7, 30 or 90 days. | No breakdown by account. |
| SAP API (`modules/sapApi/routes.ts`) | `GET /orders` lists everything waiting. `GET /po` hands out **one** order at a time (oldest first). `POST /po` answers by PO number. | Not matched yet to Zarrar's multi-PO job. Two waiting orders with the same PO number return `409 AMBIGUOUS_PO_NUMBER`. |
| Extraction | One PDF gives one header plus its lines. | A single PDF that holds **several POs** is read as one PO. |

## 2. Questions for Zarrar (blockers for Phase 4, and they shape Phase 1)

1. **What exactly did you build for multiple POs in SAP?** Pick one:
   (a) the job loops over `GET /po` until `404`;
   (b) it reads **one CSV that holds several POs** (several `H` blocks, or several PO numbers in `sap_flat`);
   (c) it creates **one Sales Order from several POs** of the same sold-to;
   (d) something else.
2. Which endpoint and CSV layout does the job call today (`/po`, `/orders`, or `/orders/{id}/csv`), and in which layout (`sap_flat` or `H/L`)?
3. How should the answer come back for several POs: one `POST` per PO, or one body listing every PO and its VBELN? What happens when some of them fail?
4. Which SAP field identifies the **account**: sold-to `KUNNR`, or something else? Can you send us a customer master extract (KUNNR, name, email domain) to seed the accounts?
5. Is it one SO per PO, or should POs from one account be **merged** into one SO?
6. Do customers ever send **several POs inside one PDF**, or always one PDF per PO?

## 3. Plan

### Phase 1 — Customer accounts *(backend, about 2–3 days)*

- New `CustomerAccount` table: `id`, `name`, `sapCustomerCode` (KUNNR), `emailAddresses[]` / `emailDomains[]`, `nameAliases[]`, `active`.
- `PORecord.accountId` (nullable FK) and `accountMatchedBy` (`EMAIL` | `CUSTOMER_CODE` | `NAME` | `MANUAL`).
- **Account resolver** (`domain/accountMatch.ts`, pure and unit-tested), run on email arrival and again after extraction:
  1. sender address, then sender domain;
  2. extracted `customerCode` equals `sapCustomerCode`;
  3. normalised `customerName` (case, punctuation, Inc/Ltd/GmbH stripped) matches the name or an alias;
  4. otherwise **unassigned**: the reviewer picks the account on the record page. That choice is audited and can save a new alias.
- Validation: blank `customerCode` → filled from the account. A code that disagrees with the account → **warning** to acknowledge, following the existing guiding principle: never silently wrong.
- **Duplicate PO number per account**: same account plus same `poNumber` on a live record → blocking warning. It catches resends and keeps SAP's `/po` free of ambiguous PO numbers.
- Admin and Operations screen to add and edit accounts, seeded from Zarrar's extract. Migration plus a backfill that runs the resolver over existing records.

### Phase 2 — Intake for several POs per account *(about 1 day)*

- Run the resolver per email, so all PDFs in one mail get the account at once.
- Notification names the account: "Apex Fastener: 4 POs received by email".
- Several mails from the same account in a row are fine as they are. Grouping is done by account, not by email.
- Tests: one mail with 3 PDFs from one sender; 2 mails from 2 addresses at the same domain; unknown sender goes to the unassigned bucket.

### Phase 3 — Organised in the Business Command Centre *(frontend, about 2–3 days)*

- **Accounts view** (new tab or page): one row per account with counts by status (Incoming, Needs review, In SAP, SO created, Failed), open value, last PO received. An **Unassigned** row sits on top when non-zero.
- Clicking an account opens the worklist filtered to it with `?account=<id>` (kept in the URL like today's view, search and sort).
- Worklist: an **Account** column, an account filter, and a **Group by: none / account / email** toggle with collapsible groups showing per-group totals.
- **Approve all ready for this account**, reusing the existing `bulk-approve` and readiness endpoints. Segregation of duties still applies per record.
- Record page: account chip with a "change account" control, and links to "other open POs from this account".
- Dashboard: a per-account table (POs, approved with no edits, SO created, failed, value) for the selected period.
- API: `GET /api/accounts`, `GET /api/accounts/summary?days=`, `account` parameter on `GET /api/records`, `PATCH /api/records/:id/account`.

### Phase 4 — Hand-off to SAP for several POs *(about 1–2 days, depends on Zarrar's answers)*

Each record keeps its own `correlationId` and attempt, so retries and audit stay per PO whatever the transport.

- If **(a) loop**: nothing new needed. Add `?account=` / `?customer=` to `GET /po` so the job can drain one customer at a time, and document it.
- If **(b) one file, many POs**: `GET /po/batch?account=&limit=` returns one CSV with every waiting PO. It's the same builder in a loop, so rows match the single-PO file byte for byte. The response lists the correlation IDs included.
- Answers: `POST /po` accepts **a list** of `{PO_NUMBER, VBELN}` (or several `sales_order:` lines). The result is reported per PO, so a partial failure leaves the failed POs waiting and visible, never lost.
- If **(c) several POs into one SO**: records share one `soNumber`. Add a `salesOrderGroup` link so the worklist shows "SO 10002525 ← 3 POs". This needs a design note before coding.
- Update `docs/04-sap-api.md` and the SAP simulator, and test end to end against the simulator.

### Phase 5 — Several POs inside one PDF *(only if Zarrar or the customer confirms, about 3–4 days)*

- The extraction prompt returns an **array** of POs, each with its page range.
- One `SourceDocument`, several child records (`parentRecordId`, `pages`). Each child goes through review and SAP on its own, and the PDF pane opens at that PO's pages.
- New sample PDF `samples/po-multi.pdf` and tests.

## 4. Order of work and what is shown when

| Step | Shown to the manager |
|---|---|
| Send §2 to Zarrar today | Answers decide Phase 4 and 5 scope |
| Phase 1 + 2 | Emails from one customer land under that account automatically |
| Phase 3 | Accounts view and grouped worklist: "Apex: 4 waiting review, 2 in SAP, 6 SO created" |
| Phase 4 | Approve all for Apex; SAP pulls them and SO numbers come back for each PO |
| Phase 5 | Only if needed |

## 5. Risks

- **Wrong account = wrong customer in SAP.** Matching never silently guesses. A fuzzy name match is shown as a suggestion, and unassigned records cannot be approved.
- **Shared senders** (a buyer at a distributor ordering for several customers). The email match then becomes a hint, and the extracted `customerCode` wins. Raise a warning when they disagree.
- **Backfill** of old records may leave many unassigned. They show in the Unassigned bucket and do not block anything already sent to SAP.
