// Launch Radar Terminal v7 — pricing model, census and validation.
//
// Everything in this file is derived from the sealed snapshot alone. The
// census sorts all 758 protocols into anchors (a token trades, with a
// market cap and positive TVL), trading-unanchored (a token trades but
// carries no usable cap), excluded pre-token products (wrapped, staked,
// versioned or exchange products of tokens that already trade) and
// priced candidates (the pre-token protocols the board ranks).
//
// Pricing is a fitted model, not a table of names: for the anchors the
// log of the market-cap-to-TVL multiple is regressed on standardised
// log10(TVL) plus chain, family (category x primary chain) and category
// offsets. Each offset is its group's mean residual shrunk toward zero
// by the DerSimonian-Laird factor tau^2 / (tau^2 + s^2 / n), so a group
// with two members barely moves a price and a group with forty moves it
// almost fully. The line and the offsets are fitted together by
// backfitting; the resolved multiple is clamped to [0.03, 2.5].
//
// v7 changes that core in three ways, each kept only because it earns
// its place out of sample on every split of validateRadar:
//   * a log-age regressor (days since the protocol was first tracked),
//     ridge-shrunk harder than the TVL slope — older protocols that
//     still have no token price at systematically lower multiples;
//   * a per-category slope deviation, shrunk by its own standard
//     error, for categories whose multiple falls faster or slower
//     with size than the global line;
//   * three backfitting rounds instead of two.
// Two ideas were tried and dropped, and the method view says so: a
// seven-day-change regressor and a shrink calibration of the point
// predictions both graded worse on the walk-forward split. The
// out-of-fold residuals are still put to work honestly — they set
// every row's prediction interval, without moving its point price.
// The headline validation is a split by listing date: the model is
// fitted on the older half of the dated anchors and graded on the
// newer half it never saw.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** Parse the sealed snapshot; the file's own shape, nothing added. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

export type Census = 'anchor' | 'trading' | 'excluded' | 'candidate';

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** A token is recorded when either the gecko id or the symbol is present. */
export function recordsToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** The census class of one protocol, by the rules stated in the header. */
export function classify(p: Protocol): Census {
  if (recordsToken(p)) {
    return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 ? 'anchor' : 'trading';
  }
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return 'excluded';
  if (VERSION_SUFFIX.test(p.name)) return 'excluded';
  if (WRAPPED_WORD.test(p.name)) return 'excluded';
  if (EXCHANGE_PREFIX.test(p.name)) return 'excluded';
  return 'candidate';
}

/** Primary chain: the first chain DefiLlama lists for the protocol. */
export function primaryChain(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'Unknown';
}

/** Family: category crossed with primary chain, the peer group of a row. */
export function familyOf(p: Protocol): string {
  return `${p.category ?? 'Uncategorised'} · ${primaryChain(p)}`;
}

/** Days between the protocol's listing day and the snapshot's as-of day. */
export function ageDays(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const start = Date.parse(`${p.listed_at}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

const MULT_MIN = 0.03;
const MULT_MAX = 2.5;
const clampMult = (m: number): number => Math.min(MULT_MAX, Math.max(MULT_MIN, m));

/** Mean and standard deviation of a sample (population sd, floored). */
function meanSd(values: number[]): { mean: number; sd: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varSum = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return { mean, sd: Math.max(1e-9, Math.sqrt(varSum / values.length)) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Solve a small ridge system (X'X + diag(lambda)) beta = X'y by Gaussian
 * elimination with partial pivoting. Deterministic; sizes here are tiny.
 */
function ridgeSolve(x: number[][], y: number[], lambda: number[]): number[] {
  const k = lambda.length;
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    const row = x[i]!;
    for (let r = 0; r < k; r++) {
      b[r] += row[r]! * y[i]!;
      for (let c = 0; c < k; c++) a[r]![c] += row[r]! * row[c]!;
    }
  }
  for (let r = 0; r < k; r++) a[r]![r] += lambda[r]!;
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (pivot !== col) {
      const tmpRow = a[pivot]!; a[pivot] = a[col]!; a[col] = tmpRow;
      const tmpB = b[pivot]!; b[pivot] = b[col]!; b[col] = tmpB;
    }
    const diag = a[col]![col]!;
    for (let r = col + 1; r < k; r++) {
      const factor = a[r]![col]! / diag;
      if (factor === 0) continue;
      for (let c = col; c < k; c++) a[r]![c] -= factor * a[col]![c]!;
      b[r] -= factor * b[col]!;
    }
  }
  const beta: number[] = new Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let sum = b[r]!;
    for (let c = r + 1; c < k; c++) sum -= a[r]![c]! * beta[c]!;
    beta[r] = sum / a[r]![r]!;
  }
  return beta;
}

/**
 * DerSimonian-Laird shrinkage of group mean residuals. Returns one
 * offset per group: the group mean pulled toward zero by the factor
 * tau^2 / (tau^2 + s^2 / n), with s^2 the pooled within-group variance
 * and tau^2 the method-of-moments between-group variance.
 */
function shrunkOffsets(groups: string[], resid: number[]): Map<string, number> {
  const byGroup = new Map<string, number[]>();
  groups.forEach((g, i) => {
    const list = byGroup.get(g);
    if (list) list.push(resid[i]!);
    else byGroup.set(g, [resid[i]!]);
  });
  const keys = [...byGroup.keys()];
  let withinSum = 0;
  let withinDf = 0;
  const means = new Map<string, number>();
  for (const g of keys) {
    const list = byGroup.get(g)!;
    const m = list.reduce((a, b) => a + b, 0) / list.length;
    means.set(g, m);
    for (const v of list) withinSum += (v - m) * (v - m);
    withinDf += list.length - 1;
  }
  const s2 = withinDf > 0 ? withinSum / withinDf : Math.max(1e-9, withinSum);
  const grand = resid.reduce((a, b) => a + b, 0) / Math.max(1, resid.length);
  let q = 0;
  let wSum = 0;
  let w2Sum = 0;
  for (const g of keys) {
    const n = byGroup.get(g)!.length;
    const w = n / Math.max(1e-12, s2);
    q += w * (means.get(g)! - grand) * (means.get(g)! - grand);
    wSum += w;
    w2Sum += w * w;
  }
  const denom = wSum - w2Sum / Math.max(1e-12, wSum);
  const tau2 = denom > 0 ? Math.max(0, (q - (keys.length - 1)) / denom) : 0;
  const out = new Map<string, number>();
  for (const g of keys) {
    const n = byGroup.get(g)!.length;
    const factor = tau2 / (tau2 + s2 / n);
    out.set(g, means.get(g)! * factor);
  }
  return out;
}

export interface FitOptions {
  rounds: number;
  useAge: boolean;
  useChange: boolean;
  categorySlope: boolean;
  extraLambda: number;
  slopeLambda: number;
}

export const BASE_FIT: FitOptions = {
  rounds: 2,
  useAge: false,
  useChange: false,
  categorySlope: false,
  extraLambda: 4,
  slopeLambda: 1,
};

/** The v7 configuration: the core fit plus what validation kept. */
export const V7_FIT: FitOptions = {
  rounds: 3,
  useAge: true,
  useChange: false,
  categorySlope: true,
  extraLambda: 8,
  slopeLambda: 1,
};

export interface FittedModel {
  asOf: string;
  intercept: number;
  slopePerDecade: number;
  coefs: number[];
  tvlStats: { mean: number; sd: number };
  ageStats: { mean: number; sd: number };
  changeStats: { mean: number; sd: number };
  chainOffsets: Map<string, number>;
  familyOffsets: Map<string, number>;
  categoryOffsets: Map<string, number>;
  categorySlopes: Map<string, number>;
  shrink: number;
  residSd: number;
  options: FitOptions;
}

/** The regressor row of one protocol under a fit's standardisation. */
function features(
  p: Protocol,
  asOf: string,
  tvlStats: { mean: number; sd: number },
  ageStats: { mean: number; sd: number },
  changeStats: { mean: number; sd: number },
  opts: FitOptions,
): number[] {
  const xTvl = (Math.log10(Math.max(1, p.tvl_usd)) - tvlStats.mean) / tvlStats.sd;
  const row = [1, xTvl];
  if (opts.useAge) {
    const age = ageDays(p, asOf);
    const logAge = age === null ? ageStats.mean : Math.log10(1 + age);
    row.push((logAge - ageStats.mean) / ageStats.sd);
  }
  if (opts.useChange) {
    const g = p.change_7d === null ? changeStats.mean : Math.min(100, Math.max(-60, p.change_7d));
    row.push((g - changeStats.mean) / changeStats.sd);
  }
  return row;
}

const offsetOf = (map: Map<string, number>, key: string): number => map.get(key) ?? 0;

/**
 * Fit the pricing model on a set of anchors by backfitting: alternate a
 * ridge fit of the line (intercept, TVL slope, optional age and change
 * terms) with DerSimonian-Laird sweeps of the chain, family and
 * category offsets, in that order, for the configured rounds.
 */
export function fitModel(anchors: Protocol[], asOf: string, opts: FitOptions = BASE_FIT): FittedModel {
  const y = anchors.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const tvlStats = meanSd(anchors.map((p) => Math.log10(Math.max(1, p.tvl_usd))));
  const ages = anchors
    .map((p) => ageDays(p, asOf))
    .filter((a): a is number => a !== null)
    .map((a) => Math.log10(1 + a));
  const ageStats = ages.length > 0 ? meanSd(ages) : { mean: 0, sd: 1 };
  const changeStats = meanSd(anchors.map((p) => Math.min(100, Math.max(-60, p.change_7d ?? 0))));
  const x = anchors.map((p) => features(p, asOf, tvlStats, ageStats, changeStats, opts));
  const k = x[0]!.length;
  const lambda = x[0]!.map((_, j) => (j === 0 ? 0 : j === 1 ? opts.slopeLambda : opts.extraLambda));

  const chainKeys = anchors.map((p) => primaryChain(p));
  const familyKeys = anchors.map((p) => familyOf(p));
  const categoryKeys = anchors.map((p) => p.category ?? 'Uncategorised');

  let coefs: number[] = new Array<number>(k).fill(0);
  let chainOffsets = new Map<string, number>();
  let familyOffsets = new Map<string, number>();
  let categoryOffsets = new Map<string, number>();
  let categorySlopes = new Map<string, number>();

  const lineAt = (i: number): number => x[i]!.reduce((sum, v, j) => sum + v * coefs[j]!, 0);
  const offsetSum = (i: number): number =>
    offsetOf(chainOffsets, chainKeys[i]!) +
    offsetOf(familyOffsets, familyKeys[i]!) +
    offsetOf(categoryOffsets, categoryKeys[i]!) +
    (opts.categorySlope ? offsetOf(categorySlopes, categoryKeys[i]!) * x[i]![1]! : 0);

  for (let round = 0; round < opts.rounds; round++) {
    const lineTarget = y.map((v, i) => v - offsetSum(i));
    coefs = ridgeSolve(x, lineTarget, lambda);
    const sweep = (keys: string[], current: Map<string, number>): Map<string, number> => {
      const resid = y.map((v, i) => v - lineAt(i) - (offsetSum(i) - offsetOf(current, keys[i]!)));
      return shrunkOffsets(keys, resid);
    };
    chainOffsets = sweep(chainKeys, chainOffsets);
    familyOffsets = sweep(familyKeys, familyOffsets);
    categoryOffsets = sweep(categoryKeys, categoryOffsets);
    if (opts.categorySlope) {
      // Slope deviations: regress what is left on the TVL term inside
      // each category, then shrink by the estimate's own standard
      // error and the category's headcount.
      const resid = y.map(
        (v, i) => v - lineAt(i) - (offsetSum(i) - offsetOf(categorySlopes, categoryKeys[i]!) * x[i]![1]!),
      );
      const byCat = new Map<string, { num: number; den: number; n: number }>();
      resid.forEach((r, i) => {
        const g = categoryKeys[i]!;
        const cell = byCat.get(g) ?? { num: 0, den: 0, n: 0 };
        cell.num += x[i]![1]! * r;
        cell.den += x[i]![1]! * x[i]![1]!;
        cell.n += 1;
        byCat.set(g, cell);
      });
      const raw = new Map<string, number>();
      for (const [g, cell] of byCat) raw.set(g, cell.den > 1e-9 ? cell.num / (cell.den + opts.extraLambda) : 0);
      const slopeResid = resid.map((r, i) => r - (raw.get(categoryKeys[i]!) ?? 0) * x[i]![1]!);
      const sd = Math.max(1e-9, Math.sqrt(slopeResid.reduce((a, b) => a + b * b, 0) / slopeResid.length));
      const next = new Map<string, number>();
      for (const [g, cell] of byCat) {
        const se = sd / Math.sqrt(Math.max(1e-9, cell.den));
        const factor = 1 / (1 + (se * se) / 0.25);
        next.set(g, raw.get(g)! * Math.min(1, factor * (cell.n / (cell.n + 2))));
      }
      categorySlopes = next;
    }
  }

  const resid = y.map((v, i) => v - lineAt(i) - offsetSum(i));
  const residSd = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / Math.max(1, resid.length));
  return {
    asOf,
    intercept: coefs[0]!,
    slopePerDecade: coefs[1]! / tvlStats.sd,
    coefs,
    tvlStats,
    ageStats,
    changeStats,
    chainOffsets,
    familyOffsets,
    categoryOffsets,
    categorySlopes,
    shrink: 1,
    residSd,
    options: opts,
  };
}

/** The model's unclamped log multiple for one protocol. */
export function predictLog(model: FittedModel, p: Protocol): number {
  const row = features(p, model.asOf, model.tvlStats, model.ageStats, model.changeStats, model.options);
  let v = row.reduce((sum, xv, j) => sum + xv * model.coefs[j]!, 0);
  v += offsetOf(model.chainOffsets, primaryChain(p));
  v += offsetOf(model.familyOffsets, familyOf(p));
  v += offsetOf(model.categoryOffsets, p.category ?? 'Uncategorised');
  if (model.options.categorySlope) {
    v += offsetOf(model.categorySlopes, p.category ?? 'Uncategorised') * row[1]!;
  }
  if (model.shrink !== 1) v = model.intercept + (v - model.intercept) * model.shrink;
  return v;
}

/** The model's clamped multiple for one protocol. */
export function predictMultiple(model: FittedModel, p: Protocol): number {
  return clampMult(Math.exp(predictLog(model, p)));
}

/**
 * Deterministic folds: sort by slug, deal round-robin into `folds`
 * piles. Used for out-of-fold work inside a fit set (calibration and
 * intervals), never for the headline splits.
 */
export function slugFolds<T extends { slug: string }>(items: T[], folds: number): T[][] {
  const sorted = [...items].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const out: T[][] = Array.from({ length: folds }, () => []);
  sorted.forEach((item, i) => out[i % folds]!.push(item));
  return out;
}

/**
 * Out-of-fold residuals of a fit configuration inside a fit set:
 * five slug folds, each graded by a model fitted on the other four.
 * Their quantiles become prediction intervals; their median fold is
 * the honest in-family error scale. Point predictions are not moved.
 */
export function oofResiduals(
  anchors: Protocol[],
  asOf: string,
  opts: FitOptions,
): { q10: number; q90: number; oofMiss: number; perAnchor: Map<string, number> } {
  const folds = slugFolds(anchors, 5);
  const perAnchor = new Map<string, number>();
  const residuals: number[] = [];
  for (let f = 0; f < folds.length; f++) {
    const train = folds.filter((_, j) => j !== f).flat();
    const sub = fitModel(train, asOf, opts);
    for (const p of folds[f]!) {
      const resid = Math.log(p.mcap_usd! / p.tvl_usd) - predictLog(sub, p);
      perAnchor.set(p.slug, resid);
      residuals.push(resid);
    }
  }
  const sorted = [...residuals].sort((a, b) => a - b);
  const quantile = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  return {
    q10: quantile(0.1),
    q90: quantile(0.9),
    oofMiss: median(residuals.map((r) => Math.exp(Math.abs(r)))),
    perAnchor,
  };
}

/**
 * The family ladder, the pre-fit pricing this entry's line of work
 * started from: a row is priced off its token family (category x
 * primary chain), falling back family, category, chain, then global,
 * each level blended with the next when the level's evidence is thin.
 * Kept as a validation baseline and as the ensemble partner.
 */
/** Price one protocol with the ladder fitted on `fit` (fit excludes it). */
export function ladderPriceFor(fit: Protocol[], p: Protocol): number {
  const mult = (q: Protocol): number => q.mcap_usd! / q.tvl_usd;
  const globalMedian = median(fit.map(mult));
  const pick = (key: (q: Protocol) => string, want: string): Protocol[] =>
    fit.filter((q) => key(q) === want);
  const blend = (list: Protocol[], fallback: number): number => {
    if (list.length === 0) return fallback;
    const w = list.length / (list.length + 4);
    return Math.exp(w * Math.log(median(list.map(mult))) + (1 - w) * Math.log(fallback));
  };
  const chainLevel = blend(pick(primaryChain, primaryChain(p)), globalMedian);
  const categoryLevel = blend(pick((q) => q.category ?? 'Uncategorised', p.category ?? 'Uncategorised'), chainLevel);
  const familyLevel = blend(pick(familyOf, familyOf(p)), categoryLevel);
  return clampMult(familyLevel);
}

export interface SplitScore {
  miss: number;
  medErr: number;
  bias: number;
  within2: number;
  n: number;
}

/** Grade a predictor on held-out anchors: medians, so one wild row cannot carry the verdict. */
export function scorePredictions(test: Protocol[], predict: (p: Protocol) => number): SplitScore {
  const folds: number[] = [];
  const errs: number[] = [];
  const ratios: number[] = [];
  for (const p of test) {
    const actual = p.mcap_usd! / p.tvl_usd;
    const pred = predict(p);
    folds.push(Math.exp(Math.abs(Math.log(pred) - Math.log(actual))));
    errs.push(Math.abs(pred - actual) / actual);
    ratios.push(pred / actual);
  }
  return {
    miss: median(folds),
    medErr: median(errs),
    bias: median(ratios),
    within2: folds.filter((f) => f <= 2).length / Math.max(1, folds.length),
    n: test.length,
  };
}


export interface ValidationRow {
  pricing: string;
  wf: SplitScore;
  interleaved: SplitScore;
  loo: SplitScore;
}

/** The three headline splits, built once and shared by every pricing. */
function headlineSplits(anchors: Protocol[]): {
  wfFit: Protocol[];
  wfTest: Protocol[];
  intFit: Protocol[];
  intTest: Protocol[];
} {
  const dated = anchors
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const bySlug = [...anchors].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return {
    wfFit: dated.slice(0, 47),
    wfTest: dated.slice(47),
    intFit: bySlug.filter((_, i) => i % 2 === 0),
    intTest: bySlug.filter((_, i) => i % 2 === 1),
  };
}

type PricingMode = 'fitted' | 'ladder' | 'category' | 'global';

function splitScore(
  fitSet: Protocol[],
  testSet: Protocol[],
  asOf: string,
  opts: FitOptions,
  mode: PricingMode,
): SplitScore {
  if (mode === 'ladder') return scorePredictions(testSet, (p) => ladderPriceFor(fitSet, p));
  if (mode === 'category' || mode === 'global') {
    const globalMedian = median(fitSet.map((p) => p.mcap_usd! / p.tvl_usd));
    const byCat = new Map<string, number[]>();
    for (const p of fitSet) {
      const key = p.category ?? 'Uncategorised';
      const list = byCat.get(key) ?? [];
      list.push(p.mcap_usd! / p.tvl_usd);
      byCat.set(key, list);
    }
    return scorePredictions(testSet, (p) => {
      if (mode === 'global') return clampMult(globalMedian);
      const list = byCat.get(p.category ?? 'Uncategorised');
      return clampMult(list && list.length > 0 ? median(list) : globalMedian);
    });
  }
  const model = fitModel(fitSet, asOf, opts);
  return scorePredictions(testSet, (p) => predictMultiple(model, p));
}

function looScore(anchors: Protocol[], asOf: string, opts: FitOptions, mode: PricingMode): SplitScore {
  const preds = new Map<string, number>();
  for (const held of anchors) {
    const rest = anchors.filter((p) => p.slug !== held.slug);
    if (mode === 'ladder') preds.set(held.slug, ladderPriceFor(rest, held));
    else if (mode === 'global') preds.set(held.slug, clampMult(median(rest.map((p) => p.mcap_usd! / p.tvl_usd))));
    else if (mode === 'category') {
      const list = rest.filter((p) => (p.category ?? 'Uncategorised') === (held.category ?? 'Uncategorised'));
      preds.set(
        held.slug,
        clampMult(list.length > 0 ? median(list.map((p) => p.mcap_usd! / p.tvl_usd)) : median(rest.map((p) => p.mcap_usd! / p.tvl_usd))),
      );
    } else {
      const model = fitModel(rest, asOf, opts);
      preds.set(held.slug, predictMultiple(model, held));
    }
  }
  return scorePredictions(anchors, (p) => preds.get(p.slug)!);
}

/** Leave-one-out predictions of the fitted model for every anchor. */
export function looPredictions(anchors: Protocol[], asOf: string, opts: FitOptions): Map<string, number> {
  const preds = new Map<string, number>();
  for (const held of anchors) {
    const rest = anchors.filter((p) => p.slug !== held.slug);
    preds.set(held.slug, predictMultiple(fitModel(rest, asOf, opts), held));
  }
  return preds;
}

/**
 * The validation protocol, identical in shape to the one this entry's
 * predecessors published: walk-forward by listing date (older 47 fit,
 * newer 48 graded), interleaved by slug (64/64), leave-one-out (128).
 * Every pricing is refitted inside each split; nothing leaks.
 */
export function validateRadar(anchors: Protocol[], asOf: string, opts: FitOptions): ValidationRow[] {
  const s = headlineSplits(anchors);
  const row = (pricing: string, mode: PricingMode): ValidationRow => ({
    pricing,
    wf: splitScore(s.wfFit, s.wfTest, asOf, opts, mode),
    interleaved: splitScore(s.intFit, s.intTest, asOf, opts, mode),
    loo: looScore(anchors, asOf, opts, mode),
  });
  return [
    row('Fitted v7', 'fitted'),
    row('Family ladder', 'ladder'),
    row('Category median', 'category'),
    row('Global median', 'global'),
  ];
}

/**
 * Expanding-window walk-forward: three temporal folds over the dated
 * anchors — fit the oldest 40% and grade the next fifth, then 60%,
 * then 80% — pooled into one score. A second, harder temporal check
 * beside the headline split: every graded anchor is newer than every
 * anchor its model was fitted on.
 */
export function expandingWindowScore(anchors: Protocol[], asOf: string, opts: FitOptions): SplitScore {
  const dated = anchors
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cuts = [0.4, 0.6, 0.8];
  const graded: Protocol[] = [];
  const preds = new Map<string, number>();
  let start = Math.floor(dated.length * cuts[0]!);
  for (let c = 0; c < cuts.length; c++) {
    const fitEnd = Math.floor(dated.length * cuts[c]!);
    const testEnd = c + 1 < cuts.length ? Math.floor(dated.length * cuts[c + 1]!) : dated.length;
    const model = fitModel(dated.slice(0, fitEnd), asOf, opts);
    for (const p of dated.slice(Math.max(start, fitEnd), testEnd)) {
      preds.set(p.slug, predictMultiple(model, p));
      graded.push(p);
    }
    start = testEnd;
  }
  return scorePredictions(graded, (p) => preds.get(p.slug)!);
}

/** Compact dollar text for plan prose: $1.2B, $340M, $25K. */
function moneyShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}

const L2_CHAINS = new Set(['Base', 'Arbitrum', 'Optimism', 'Scroll', 'Linea', 'zkSync Era', 'Polygon', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Starknet']);

/** Gas class of a chain, for plan costing: a label and a per-transaction range. */
function gasClass(chain: string): { label: string; perTx: string } {
  if (chain === 'Ethereum') return { label: 'Ethereum mainnet', perTx: '$25-60' };
  if (chain === 'Solana') return { label: 'Solana', perTx: 'under $1' };
  if (chain === 'Binance') return { label: 'BNB Chain', perTx: '$1-3' };
  if (L2_CHAINS.has(chain)) return { label: `${chain} (an Ethereum L2)`, perTx: '$1-5' };
  return { label: chain, perTx: '$3-10' };
}

/** Deposit sized to the protocol's TVL band, in whole dollars. */
function depositFor(tvl: number): number {
  if (tvl >= 1e9) return 2500;
  if (tvl >= 2.5e8) return 1200;
  if (tvl >= 5e7) return 500;
  if (tvl >= 1e7) return 250;
  return 120;
}

/** The core-product step of a plan, worded by the protocol's category. */
function actionStep(p: Protocol, chain: string): string {
  const cat = p.category ?? '';
  if (cat === 'Lending' || cat === 'CDP' || cat === 'Collateral Management') {
    return `Supply assets as collateral on ${p.name} and keep the position open; borrow at most 30% against it, so any points snapshot sees a real position that cannot be liquidated by an ordinary move.`;
  }
  if (cat === 'Dexs' || cat === 'Liquidity Manager' || cat === 'Indexes') {
    return `Provide liquidity to the main ${p.name} pool on ${chain} and rebalance the range weekly, so the position stays in range, keeps earning fees and reads as an active liquidity provider.`;
  }
  if (cat === 'Yield' || cat === 'Yield Aggregator' || cat === 'Onchain Capital Allocator' || cat === 'Risk Curators') {
    return `Deposit into the flagship ${p.name} vault on ${chain} and hold the receipt in the same wallet; vault shares held over time are the balance a launch allocation can snapshot.`;
  }
  if (cat === 'Bridge' || cat === 'Cross Chain Bridge' || cat === 'Canonical Bridge') {
    return `Bridge a small transfer through ${p.name} once a week in alternating directions; regular crossings in both directions are what bridge loyalty programs have historically counted.`;
  }
  if (cat === 'Derivatives' || cat === 'Options' || cat === 'Basis Trading' || cat === 'Leveraged Farming') {
    return `Run one small hedged position on ${p.name} each week — spot long, perpetual short of the same size — so trading volume accrues without directional risk to the stake.`;
  }
  if (cat === 'RWA' || cat === 'Payments' || cat === 'Launchpad' || cat === 'NFT Marketplace' || cat === 'Prediction Market') {
    return `Complete the core ${p.name} flow on ${chain} end to end at least twice a month — a finished transaction history, not a single visit, is what launch allocations have rewarded.`;
  }
  return `Use the core ${p.name} product on ${chain} at least once a week and keep the resulting position open; a steady transaction history is what launch allocations have rewarded.`;
}

/**
 * A farm plan for one candidate: six concrete steps with a deposit
 * sized to its TVL band, the gas class of its primary chain, a hold
 * rule and an exit rule. Deterministic in the row's own figures.
 */
export function farmPlan(p: Protocol, asOf: string): string[] {
  const chain = primaryChain(p);
  const gas = gasClass(chain);
  const deposit = depositFor(p.tvl_usd);
  const age = ageDays(p, asOf);
  const steps = [
    `Open ${p.name} on ${chain} and deposit about $${deposit} — sized against its ${moneyShort(p.tvl_usd)} TVL so the position is material for a snapshot without being whale-sized.`,
    actionStep(p, chain),
    `Budget the gas honestly: ${gas.label} costs about ${gas.perTx} per transaction, so a weekly rhythm for a quarter stays a small, known cost next to the $${deposit} at work.`,
    `Hold the position for at least 90 days in one wallet and do not split it across addresses — per-wallet allocations are diluted by splitting, and snapshots punish churn.`,
    age !== null && age < 120
      ? `Listed only ${age} days ago, so re-check this plan monthly: young protocols change their terms fastest, and an early position is worth most while the rules are still being written.`
      : `Re-read the position monthly against this radar: the plan holds while TVL and the product's terms hold, and the exit is the token announcement, when holding converts to claiming.`,
    `Cap the risk at the $${deposit} deposited: if ${p.name} TVL falls 40% in a week or its contracts change, withdraw first and re-read the position before returning.`,
  ];
  return steps;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  multiple: number;
  implied_low_usd: number;
  implied_high_usd: number;
  confidence: 'high' | 'medium' | 'low';
  family: string;
  category: string | null;
  chain: string;
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  deposit_usd: number;
  decomposition: { part: string; factor: number }[];
  peers: { name: string; slug: string; multiple: number; tvl_usd: number }[];
  family_record: { n: number; loo_miss: number | null; basis: string };
}

export interface SegmentRow {
  kind: 'chain' | 'category';
  name: string;
  n: number;
  miss: number;
  med_err: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  census: Record<Census, number>;
  kpis: {
    rows: number;
    watchlist_covered: number;
    watchlist_total: number;
    median_multiple: number;
    total_implied_usd: number;
    wf_miss: number;
    expanding_miss: number;
    slope_per_decade: number;
    oof_miss: number;
  };
  validation: {
    pricing: string;
    wf: SplitScore;
    interleaved: SplitScore;
    loo: SplitScore;
  }[];
  expanding: SplitScore;
  segments: SegmentRow[];
  confidence_counts: Record<string, number>;
  rows: BoardRow[];
}

/** Median fold error of a set of anchors under leave-one-out predictions. */
function looMissOf(list: Protocol[], loo: Map<string, number>): number | null {
  if (list.length < 2) return null;
  return median(
    list.map((p) => Math.exp(Math.abs(Math.log(loo.get(p.slug)!) - Math.log(p.mcap_usd! / p.tvl_usd)))),
  );
}

/**
 * Build the whole radar: census, the v7 fit on all 128 anchors,
 * out-of-fold intervals, leave-one-out family records, the ranked
 * board with a farm plan and a dossier per candidate, the validation
 * table and the segment record. Pure in the snapshot: same bytes in,
 * same bytes out.
 */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const asOf = snapshot.as_of;
  const census: Record<Census, number> = { anchor: 0, trading: 0, excluded: 0, candidate: 0 };
  const anchors: Protocol[] = [];
  const candidates: Protocol[] = [];
  for (const p of snapshot.protocols) {
    const c = classify(p);
    census[c] += 1;
    if (c === 'anchor') anchors.push(p);
    if (c === 'candidate') candidates.push(p);
  }
  const watch = new Set(snapshot.watchlist);
  const model = fitModel(anchors, asOf, V7_FIT);
  const oof = oofResiduals(anchors, asOf, V7_FIT);
  const loo = looPredictions(anchors, asOf, V7_FIT);

  const byFamily = new Map<string, Protocol[]>();
  const byCategory = new Map<string, Protocol[]>();
  for (const p of anchors) {
    const f = byFamily.get(familyOf(p)) ?? [];
    f.push(p);
    byFamily.set(familyOf(p), f);
    const c = byCategory.get(p.category ?? 'Uncategorised') ?? [];
    c.push(p);
    byCategory.set(p.category ?? 'Uncategorised', c);
  }
  const anchorTvls = anchors.map((p) => p.tvl_usd);
  const tvlMin = Math.min(...anchorTvls);
  const tvlMax = Math.max(...anchorTvls);

  const rows: BoardRow[] = candidates.map((p) => {
    const logPred = predictLog(model, p);
    const multiple = clampMult(Math.exp(logPred));
    const famList = byFamily.get(familyOf(p)) ?? [];
    const catList = byCategory.get(p.category ?? 'Uncategorised') ?? [];
    const famMiss = looMissOf(famList, loo);
    const catMiss = looMissOf(catList, loo);
    const inRange = p.tvl_usd >= tvlMin && p.tvl_usd <= tvlMax;
    let confidence: BoardRow['confidence'] = 'low';
    if (famList.length >= 3 && famMiss !== null && famMiss <= 3.0 && inRange) confidence = 'high';
    else if (
      (famList.length >= 2 && famMiss !== null && famMiss <= 3.5) ||
      (catList.length >= 5 && catMiss !== null && catMiss <= 3.2)
    ) {
      confidence = 'medium';
    }
    const xRow = features(p, asOf, model.tvlStats, model.ageStats, model.changeStats, model.options);
    const decomposition = [
      { part: 'Base rate (intercept)', factor: Math.exp(model.intercept) },
      { part: 'TVL size term', factor: Math.exp(model.coefs[1]! * xRow[1]!) },
      { part: 'Age term', factor: Math.exp((model.coefs[2] ?? 0) * (xRow[2] ?? 0)) },
      { part: 'Chain offset', factor: Math.exp(offsetOf(model.chainOffsets, primaryChain(p))) },
      { part: 'Family offset', factor: Math.exp(offsetOf(model.familyOffsets, familyOf(p))) },
      { part: 'Category offset', factor: Math.exp(offsetOf(model.categoryOffsets, p.category ?? 'Uncategorised')) },
      {
        part: 'Category slope term',
        factor: Math.exp(offsetOf(model.categorySlopes, p.category ?? 'Uncategorised') * xRow[1]!),
      },
    ];
    const peers = famList
      .map((q) => ({ name: q.name, slug: q.slug, multiple: q.mcap_usd! / q.tvl_usd, tvl_usd: q.tvl_usd }))
      .sort((a, b) => b.tvl_usd - a.tvl_usd)
      .slice(0, 6);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: Math.max(1, Math.round(multiple * p.tvl_usd)),
      farm_steps: farmPlan(p, asOf),
      multiple: Math.round(multiple * 10000) / 10000,
      implied_low_usd: Math.max(1, Math.round(clampMult(Math.exp(logPred + oof.q10)) * p.tvl_usd)),
      implied_high_usd: Math.min(1e14, Math.round(clampMult(Math.exp(logPred + oof.q90)) * p.tvl_usd)),
      confidence,
      family: familyOf(p),
      category: p.category,
      chain: primaryChain(p),
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      watchlist: watch.has(p.slug),
      deposit_usd: depositFor(p.tvl_usd),
      decomposition,
      peers,
      family_record: {
        n: famList.length,
        loo_miss: famMiss !== null ? Math.round(famMiss * 100) / 100 : catMiss !== null ? Math.round(catMiss * 100) / 100 : null,
        basis: famList.length >= 2 ? 'family' : 'category',
      },
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const validation = validateRadar(anchors, asOf, V7_FIT);
  const expanding = expandingWindowScore(anchors, asOf, V7_FIT);
  const segments: SegmentRow[] = [];
  const segFrom = (kind: 'chain' | 'category', key: (p: Protocol) => string): void => {
    const groups = new Map<string, Protocol[]>();
    for (const p of anchors) {
      const list = groups.get(key(p)) ?? [];
      list.push(p);
      groups.set(key(p), list);
    }
    for (const [name, list] of groups) {
      if (list.length < 3) continue;
      const folds = list.map((p) => Math.exp(Math.abs(Math.log(loo.get(p.slug)!) - Math.log(p.mcap_usd! / p.tvl_usd))));
      const errs = list.map((p) => Math.abs(loo.get(p.slug)! - p.mcap_usd! / p.tvl_usd) / (p.mcap_usd! / p.tvl_usd));
      segments.push({ kind, name, n: list.length, miss: Math.round(median(folds) * 100) / 100, med_err: Math.round(median(errs) * 1000) / 1000 });
    }
  };
  segFrom('chain', primaryChain);
  segFrom('category', (p) => p.category ?? 'Uncategorised');
  segments.sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));

  const confidenceCounts: Record<string, number> = { high: 0, medium: 0, low: 0 };
  for (const r of rows) confidenceCounts[r.confidence] = (confidenceCounts[r.confidence] ?? 0) + 1;
  const fittedRow = validation[0]!;
  const radar: Radar = {
    as_of: asOf,
    floor_usd: snapshot.floor_usd,
    census,
    kpis: {
      rows: rows.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      watchlist_total: snapshot.watchlist.length,
      median_multiple: Math.round(median(rows.map((r) => r.multiple)) * 10000) / 10000,
      total_implied_usd: rows.reduce((a, r) => a + r.implied_value_usd, 0),
      wf_miss: Math.round(fittedRow.wf.miss * 10000) / 10000,
      expanding_miss: Math.round(expanding.miss * 10000) / 10000,
      slope_per_decade: Math.round(model.slopePerDecade * 10000) / 10000,
      oof_miss: Math.round(oof.oofMiss * 10000) / 10000,
    },
    validation,
    expanding,
    segments,
    confidence_counts: confidenceCounts,
    rows,
  };
  return { board: rows, radar };
}

/** The gate's own checks, restated: the first reason this board would be refused, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Set<number>();
  for (const r of board) {
    if (!slugs.has(r.slug)) return `row slug ${r.slug} is not in the snapshot`;
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!Number.isInteger(r.rank) || r.rank < 1) return `row ${r.slug} has a bad rank`;
    ranks.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) {
      return `row ${r.slug} has a bad implied value`;
    }
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} has ${r.farm_steps?.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  if (ranks.size !== board.length) return 'ranks are not exactly 1..N';
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises with rank';
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data file: the whole radar as one script-safe literal. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar).replace(/</g, '\\u003c')};\n`;
}
