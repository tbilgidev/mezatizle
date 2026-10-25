# Product-lot dedup — sparse sunulan KPI

**Recording:** `8dcb0555-f015-49f1-9f8e-2205270a1aff` · `@yesilkoyantika_` · ~34 dk  
**Funnel:** [Rapor detay](https://tolga-mini.tailf479ba.ts.net/mezatizle/reports/8dcb0555-f015-49f1-9f8e-2205270a1aff) · [Raporlar](https://tolga-mini.tailf479ba.ts.net/mezatizle/reports)  
**Branch:** `cursor/product-lot-dedup-297f`

## Before → after (Yeşilköy)

| KPI | Before (broken) | After (lot model) |
|-----|-----------------|-------------------|
| `productsOffered` | **124** | **15** |
| `totalAskTry` | **≈1.048.809 TRY** | **≈118.550 TRY** |
| `productsSold` | 30 (no `@` buyers) | **0** |
| `totalSoldTry` | ≈27.000 TRY | **0** |
| Transcript / comments | 1023 / 0 | unchanged |

124 lots in ~34 dk was absurd (~16 s/lot). 15 lots ≈ 2+ dk/lot — under-count preferred over phantom re-shows.

False sales cleared: seller «satıldı» / «tamam» without follower `@` / «aldım» is **not** a sale.

## Lot model

**One lot = one product window**, not every price utterance.

| Rule | Behavior |
|------|----------|
| Open | First priced ask (`seller_aldim_ask`, `acilisim_ask`, `seller_price_line` «X bin ile mezat olsun», …) |
| Opening ask | Counted **once** in `totalAskTry` |
| Re-show merge | Same/similar ask (±20%) within **180 s** → same lot (camera pan / rotate / repeat) |
| Early revise | Amount change within **45 s** of open → same lot (settle sticky ask) |
| New lot | Different ask after **≥75 s**, or `pass` / `sold` / «geçiyoruz» |
| Not in ask sum | Pey bids, counter-offers, restatements, amounts &lt; 500 or &gt; 100 000 TRY |
| Sale | Still needs follower «aldım» / pey+win + `@username` — seller ask ≠ sale |

**Code:** `packages/shared/src/auction.ts` — `buildProductLots`, `summarizeOfferWindows`, `reconcileMezatWindows`  
**Reports:** `apps/api/src/routes/reports.ts` → `loadOfferKpis` uses lot summary (not raw `COUNT(*)` of `price_mention`).

## Re-run (keeps transcript + comments)

```bash
bun run ./scripts/rerun-yesilkoy-lot-dedup.ts
# optional: bun run ./scripts/rerun-yesilkoy-lot-dedup.ts <recording-id>
```

Auto-follow poller (5–6 min, pause while recording) untouched.
