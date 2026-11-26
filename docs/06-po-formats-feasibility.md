# Feasibility — real customer POs (8 files) and Excel intake

> Customer PO numbers, vendor codes and prices are left out of this copy on purpose.

**Ask (26 Nov):** check whether the attached customer documents can be read completely, with every field taken, and make the POC handle these formats, **including Excel sheets as POs**, not only PDFs.

**How this was checked:** each file's text layer was read with `pdftotext`, the page images were looked at, and the Excel workbook was opened cell by cell. The live Gemini extraction was **not** run: no `GEMINI_API_KEY` in this environment, and these are real customer documents that should not be sent to an outside service without your say-so. Section 5 says how to run that check.

---

## 1. Verdict at a glance

| # | Customer | Document | Pages / lines | Text layer | Readable? | Makes a Sales Order as the app stands? |
|---|---|---|---|---|---|---|
| 1 | Accolade Electronics | PO `<PO no.>`, 07-10-2026 | 2 p / 1 line | yes | **Yes, fully** | Almost: customer code missing (see §2.1) |
| 2 | Centum Electronics | PO `<PO no.>`, 2026-10-09 | 5 p / 3 lines | yes | **Yes, fully** | Almost: customer code missing |
| 3 | Star Engineers Vietnam | PO `<PO no.>`, 06/10/2026 (USD) | 1 p / 9 lines | **no: photocopier scan** | **Yes**: clean scan, but a stamp covers the PO number | Almost: customer code missing; mixed decimal styles |
| 4 | Flash Electronics | PO `<PO no.>`, plant 1800 | 12 p / 120 lines | yes (Ω garbled as `Ù`) | Yes | **No**: every quantity is `OPEN`, PO amount 0.00 |
| 5 | FIEM Industries | PO `<PO no.>` rev 18, valid to 31.03.2027 | **36 p / 411 lines** | yes | Yes, but too big for one extraction call | **No**: no quantities; price per 10 |
| 6 | Dhoot Transmission | **Scheduling-agreement amendment** `<PO no.>` | 6 p / ~45 lines | yes | Yes | **No**: old rate → new rate only, no quantities |
| 7 | Varroc Engineering | **Scheduling-agreement amendment** `<PO no.>` / amd `<PO no.>` | 4 p / 2 lines | yes | Yes | **No**: price change only |
| 8 | Star Engineers Vietnam | **Excel delivery schedule and forecast** (`.xlsx`) | 1 sheet, 44 columns, 203 formulas | n/a | Yes, as data (no OCR needed) | **No**: it is a schedule across 5 POs, not one PO |

**Summary:**
- **Readable:** all eight. Seven have a real text layer, and the one scan is clean.
- **Close to working today:** three standard POs (1–3). They only need the customer-account fix that Phase 1 of `05-multi-po-plan.md` already plans.
- **Not standard POs:** the other five are open or rate-contract POs, scheduling-agreement amendments, and a delivery schedule. A standard Sales Order (VA01) needs a quantity, and none of these carry one. **This is a business decision first, not an OCR problem:** which SAP document should each become?

## 2. What would go wrong today, and the fix

### 2.1 Customer code is never on the PO *(affects all 8)*
Each PO prints **Millennium's vendor code at that customer** (for example `V0…`, a six-digit number, or a BP code). SAP's sold-to number (KUNNR) is never printed. `customerCode` is a required field, so every record would stop at review.
**Fix:** customer accounts (plan 05, Phase 1). Store each customer's "our vendor code" as an alias on the account, then fill `customerCode` from the account master.

### 2.2 Several Millennium companies and branches receive POs
The POs are addressed to Pune/Chakan (Accolade, Flash, Varroc), Mumbai (Dhoot), Noida (FIEM), Pimpri (Centum), and **Millennium Semiconductors PTE LTD, Singapore** (Star, in USD).
**Fix:** extract the *vendor-side* entity (name and GSTIN), and map it to the SAP sales organisation and plant. The Singapore company is probably a different sales org or company code; ask Zarrar.

### 2.3 Price per 10 / per 1,000 *(FIEM, Flash, Dhoot, Varroc)*
- FIEM prints `1.09 /10`, which is a tenth of that per piece.
- Flash, Dhoot and Varroc price per 1,000 or per 100.

The app assumes the price is per unit, so `quantity × unitPrice = line value` would be out by 10–1,000×.
**Fix:** a new line field `priceUnit`, sent to SAP as the condition pricing unit (KPEIN). Validation then computes `qty × price ÷ priceUnit`.

### 2.4 Open, rate-contract and amendment documents *(Flash, FIEM, Dhoot, Varroc)*
- **Flash and FIEM** are rate contracts: `QTY: OPEN`, "Delivery as per our requirement", PO amount 0.00, and FIEM is at revision 18.
- **Dhoot and Varroc** are price amendments to scheduling agreements, with old and new rates and effective dates.

**Fix:** add `documentType` to extraction (`STANDARD_PO`, `OPEN_PO`, `SA_AMENDMENT`, `DELIVERY_SCHEDULE`, `OTHER`) and apply validation per type, so quantity is required only for `STANDARD_PO`. Each type goes to the SAP target Zarrar confirms. Likely targets:
- `OPEN_PO`: a contract or scheduling agreement (VA41 / VA31).
- `SA_AMENDMENT`: a price condition update (VK11 / VA32).
- `DELIVERY_SCHEDULE`: release lines against an existing agreement.

Until then, these records are kept as **reference only**, never sent as a Sales Order.

### 2.5 Very long POs *(FIEM: 411 lines over 35 pages; Flash: 120 lines)*
One Gemini call for 411 lines risks hitting the 120 s timeout, and risks a truncated answer that quietly drops lines.
**Fix:**
- Extract in **page batches** (about 6–8 pages per call), then merge the lines and drop the header repeated on every page.
- Compare the line count with the count the PO prints (FIEM's "Item Added 411"). A mismatch is a blocking warning.
- Page the line-items table on the record page.

### 2.6 Revisions and amendments of the same PO number
FIEM `<PO no.>` is at **Rev 18**. Also, the FIEM file name says `<PO no.>` but the document says another.
**Fix:**
- Extract `revisionNo` and `amendmentNo`.
- A new revision of a PO that has already reached SAP is a **change**, not a duplicate. It is flagged "revision of …" and shown against the earlier one.
- Always trust the document over the file name, and show a warning when they disagree.

### 2.7 Smaller format issues
| Issue | Where | Fix |
|---|---|---|
| Stamp over the PO number and date | Star scan | Gemini reads the image, so this is likely fine, but give those two fields a low-confidence rule in the Star vendor profile so a person checks them. |
| Mixed decimals in one table: qty `27000.00`, price `0,3072`, value `8.294,40` | Star scan | Read the number style per column, not per document. Add a validator test for this case. |
| `Ω` garbled as `Ù` in the text layer | Flash | Gemini reads the page image, so this is probably unaffected. Add a normalising step and test it. |
| Line numbers with gaps (1, 2, 4) | Centum | Keep the printed numbers; the prompt already says so. |
| PO numbers with `/` or spaces, longer than 10 characters (`<PO no.>`, `<PO no.>`) | Accolade, Star | SAP's `/po` flow treats PO numbers as CHAR10. Confirm with Zarrar that BSTKD (CHAR35) is used. |
| MPN and HSN on a second row of the line | Centum, Flash, FIEM | Map MPN to `customerMaterialNumber` or a new `mpn` field. Add an `hsnCode` line field (GST). |
| Taxes (CGST/SGST/IGST) | all Indian POs | Keep `poTotalValue` pre-tax (the prompt already does). Optionally capture tax per line. |

## 3. Excel as a PO

### What the attached workbook is
`Scheduleforsupplier-Millen.xlsx` comes from Star Engineers Vietnam. It has one sheet, 31 rows and 44 columns, with merged title cells and 203 formulas. It is a **supply schedule**, with one row per part number (SAP code, MPN, maker, price, new price) and these column groups:
- Ordered quantities per PO: `PO <PO no.>`, `PO <PO no.>`, `PO <PO no.>`, `PO <PO no.>`, `PO <PO no.>`.
- Monthly deliveries, actual and planned: `5-Apr` … `5-Mar 2027`.
- `Balance PO`.
- A 12-month forecast: `Apr FC.27` … `Mar FC.28`.

It also carries the variance rules (M 100 %, M+1 80 %, and so on).

The `PO <PO no.>` column matches scan #3 exactly: line for line. So the Excel file is the delivery schedule for that PO, not a separate order.

### Feasibility: yes, and more reliable than PDF
Spreadsheet cells are already data, so nothing is lost to OCR. The work is in **understanding the layout**, which varies by customer.

### Design
1. **Accept the file:**
   - `.xlsx`, `.xls` and `.csv` are accepted by the upload screen and by the Outlook intake (attachment filter).
   - Files are recognised by content (zip signature and content types), not by extension.
   - The size limit and duplicate hash work as they do for PDFs.
   - `SourceDocument.mimeType` already exists.
2. **Read it** with SheetJS (`xlsx`) or `exceljs` on the server:
   - every visible sheet;
   - cached formula **values**, not formulas;
   - merged cells filled in;
   - hidden rows and columns skipped and listed.
3. **Extract it:**
   - Turn each sheet into a compact table text (row and column coordinates kept, for example `P8 = 27000`).
   - Send that text to Gemini with an Excel prompt and the same JSON schema, plus `documentType`.
   - Every value cites its **cell** (`sourceCell: "P8"`) in place of a page and box. This is cheaper and more exact than sending a PDF.
4. **Use a saved mapping per account:** once a reviewer confirms how a customer's sheet is laid out (header row, PO column, quantity columns), save it on the account. Later sheets from that customer are then mapped **deterministically**, without the model. The model is only used for a layout not seen before.
5. **Unpivot schedules:** a `DELIVERY_SCHEDULE` sheet becomes schedule lines (`part × date × qty`), linked to the PO it names, here <PO no.>.
6. **Review screen:** a spreadsheet viewer (HTML table with the sheet's own row and column labels) in place of the PDF pane. Clicking a field highlights its source cell.

## 4. Plan and effort

| Step | Work | Effort |
|---|---|---|
| 0 | **Questions for Zarrar and the business** (§6) | today |
| 1 | Customer accounts plus vendor-code aliases (from plan 05). Fixes §2.1 for all eight | 2–3 d |
| 2 | Extraction schema additions: `documentType`, `priceUnit`, `revisionNo`, vendor-side entity and GSTIN, `hsnCode`, `mpn`, printed line count. Prompt rules and validation per document type | 2 d |
| 3 | Page-batched extraction for long PDFs, line-count check, paged line table | 2 d |
| 4 | Revisions: "revision of" link, change instead of duplicate, file name vs document warning | 1 d |
| 5 ✅ | Excel intake (**done**, see README): accept and recognise, parse to table text, Excel prompt with cell citations, spreadsheet viewer | 3–4 d |
| 6 | Saved per-account Excel mapping, and unpivoting schedules into delivery lines | 2–3 d |
| 7 | Vendor profiles for the seven customers (prompts are data), plus an **accuracy harness**: hand-checked expected JSON for each file, a script that extracts and scores field by field | 2 d |
| 8 | SAP routing per document type, once Zarrar confirms | depends on answers |

Steps 1–3 and 7 together make the three standard POs (Accolade, Centum, Star scan) go end to end, and read the other four PDFs correctly as reference records. Steps 5–6 add Excel.

## 5. Proving it: the accuracy run

The real test is running the eight files through the Gemini extraction and scoring every field. To do that:
- **Allow it:** either set `GEMINI_API_KEY` in this environment, or run the harness on the Render deployment, which already has the key.
- **Agree that these customer documents may go to Google's Gemini API.** That is what production does anyway.

**Keep the files out of git.** They are real customer documents with GSTINs, prices and contact names. Store them as private fixtures (an ignored `fixtures-private/` folder, or the database) rather than in `samples/`.

## 6. Questions to settle

1. **For Zarrar:** what SAP document should each type become?
   - Open or rate-contract PO (Flash, FIEM): contract or scheduling agreement?
   - SA price amendment (Dhoot, Varroc): condition record update?
   - Delivery schedule (Star Excel): schedule lines against which agreement?
2. **For Zarrar:** pricing unit. Does the SO take KPEIN (per 10 / per 1,000), or must prices be converted to per-unit?
3. **For Zarrar:** which sales org or company code handles Millennium Singapore (USD) and Noida orders?
4. **For Zarrar:** is the customer PO number sent to BSTKD (CHAR35)? the longer ones do not fit CHAR10.
5. **For the business:** for a rate-contract PO with open quantity, does a person add quantities in the app from the monthly schedule, or do they wait for the Excel schedule and take quantities from it?
6. **For the business:** is the Star-style Excel the only spreadsheet layout, or do other customers send different ones? Two or three more examples would show whether saved mappings are enough.
