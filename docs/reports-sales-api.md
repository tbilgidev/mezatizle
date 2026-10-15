# Reports = real sales list (UI contract)

Funnel: `https://tolga-mini.tailf479ba.ts.net/mezatizle/`  
Local API: `http://127.0.0.1:43127`

**Raporlar is a sales analysis list** (what sold + thumbnail + price + who bought), **not** job logs. Prefer `report.sales[]`; `jobs` is debug-only.

---

## GET `/api/reports/:recordingId`

Returns `{ report }` with list aggregates plus:

| Field | Type | Notes |
|-------|------|--------|
| `sales[]` | array | Ordered by `soldAt` |
| `sales[].id` | uuid | Sale id |
| `sales[].productId` | uuid\|null | Product row |
| `sales[].productTitle` | string\|null | Short lot label (often matched ASR line) |
| `sales[].productDescription` | string\|null | Longer matched line / auto note |
| `sales[].thumbnailUrl` | string\|null | e.g. `/api/products/<productId>/image` |
| `sales[].buyerUsername` | string\|null | Only real `@handle` — never invented |
| `sales[].spokenBuyerName` | string\|null | Spoken first name if different; UI-only |
| `sales[].amountTry` | number\|null | TRY major units |
| `sales[].amountCents` | number\|null | TRY × 100 |
| `sales[].currency` | `"TRY"` | |
| `sales[].saleMethod` | string\|null | `seller_aldim` \| `sold_phrase` \| `sold_phrase_bid_enriched` \| … |
| `sales[].soldAt` | ISO\|null | `recorded_at + offsetMs` |
| `sales[].offsetMs` | number\|null | ms on master timeline |
| `sales[].confidence` | number\|null | 0–1 |
| `sales[].status` | string | default `needs_review` |
| `sales[].evidenceIds` | uuid[] | `sale_evidence.id` |
| `sales[].explanationTr` | string\|null | Human Kanıt blurb |

Also: `saleCount`, `sumAmountTry`, `eventCounts`, `transcriptSegmentCount`, `commentCount`.

---

## GET `/api/products/:id/image`

JPEG thumbnail from the product frame nearest to sale `offsetMs` (`storage/products/<id>.jpg`).  
404 if product or image missing. Supports byte-range like recording media.

Under Funnel: `/mezatizle/api/products/:id/image`.

---

## Accuracy rules (LOCAL)

- Comment `aldım` → **bid** (never sold).
- Seller transcript `aldım … bin/lira` → **sold** (buyer often unknown).
- Turkish word amounts: `on bin`, `altı bin`, `üç bin beş yüz`, `25 bin`.
- Prefer **unknown** buyer/price over inventing.
- Gate: `SALE_MIN_CONFIDENCE` default **0.78**; status always starts `needs_review`.
