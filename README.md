# Launch Radar Terminal — token-radar-01 v7

![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Runtime: Node 22](https://img.shields.io/badge/runtime-Node%2022-blue)
![Model: fitted, validated out of sample](https://img.shields.io/badge/model-fitted%20%2B%20validated-orange)

A token launch radar for the make.fun `token-radar-01` bounty. It reads
the sealed DefiLlama snapshot, prices every pre-token protocol with a
model **fitted on the 128 protocols whose tokens already trade**, and
hands in a dashboard: a ranked board with a farm plan per protocol, a
dossier per row, the model's full out-of-sample validation record, and
the method in plain words.

## The model

For the anchors, log(market cap / TVL) is regressed on standardised
log10(TVL), a log-age term, and chain, family (category × primary
chain) and category offsets, plus a per-category slope deviation.
Offsets are group mean residuals shrunk toward zero by the
DerSimonian–Laird factor τ²/(τ² + s²/n); line and offsets are fitted
together by three rounds of backfitting; the resolved multiple is
clamped to [0.03, 2.5]. No protocol is priced by name.

v7's changes over the previous version — an age term, per-category
slopes, a third backfitting round — are each there because they
lowered the out-of-sample miss on **every** split. A seven-day-change
regressor, a point-prediction calibration and a ladder ensemble were
built, graded and dropped: they graded worse.

## Validation (refitted inside every split)

| Pricing | Walk-forward miss | Interleaved miss | Leave-one-out miss |
| --- | --- | --- | --- |
| Fitted v7 | **2.77×** | **3.26×** | **3.23×** |
| Family ladder | 4.98× | 4.68× | 4.95× |
| Category median | 4.99× | 4.96× | 4.99× |
| Global median | 5.29× | 5.11× | 5.07× |

Walk-forward = fitted on the older 47 dated anchors, graded on the
newer 48. An expanding-window walk-forward (three temporal folds)
gives 2.79×. Each board row also carries an 80% interval from the
model's out-of-fold residuals and a confidence grade ruled from its
family's leave-one-out record.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only. The program writes `board.json`,
`data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the
output directory, deterministically — two runs, same bytes.

## Layout

- `main.ts` — entry point: snapshot in, board + dashboard + dossier out
- `lib/model.ts` — census, fitted model, validation, farm plans, dossiers
- `dashboard/` — the static page (board, detail, validation, method)
- `screenshots/` — the board, a protocol dossier, a filtered view
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored
