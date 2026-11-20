// Launch Radar Terminal v7 — dashboard logic.
// Renders window.RADAR (written by main.ts from the same board the
// gate reads): a filterable, sortable board of the priced pre-token
// protocols, a dossier per protocol, the model's out-of-sample
// validation record, and the method in plain words. No network.
(function () {
  'use strict';
  var R = window.RADAR;
  var main = document.getElementById('board');
  var state = { q: '', chain: '', category: '', conf: '', wl: false, sort: 'value' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(v);
  }
  function mult(x) { return x.toFixed(2) + 'x'; }
  function pct(x) { return (x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(1) + '%'); }
  function score(s) {
    return '<td class="num">' + s.miss.toFixed(2) + 'x</td><td class="num">' + s.medErr.toFixed(3) +
      '</td><td class="num">' + s.bias.toFixed(2) + '</td><td class="num">' + (s.within2 * 100).toFixed(0) + '%</td>';
  }

  function header(active) {
    var k = R.kpis;
    var h = '<header class="top"><h1>Launch Radar <span class="term">Terminal</span></h1>' +
      '<div class="sub">Every pre-token protocol in the snapshot, priced by a model <b>fitted on the 128 protocols whose tokens already trade</b> — ' +
      'log market-cap/TVL on size, age, chain, family and category, with shrunk offsets and per-category slopes. ' +
      'Graded out of sample before it is trusted: fitted on the older half of the dated anchors, its typical miss on the newer half is <b>' +
      k.wf_miss.toFixed(2) + 'x</b>. Snapshot as of ' + esc(R.as_of) + '. A board row is a claim about value if the record stayed as it is, never a promise of a token.</div>' +
      '<div class="kpis">' +
      '<div class="kpi"><div class="v">758</div><div class="k">protocols scanned</div></div>' +
      '<div class="kpi"><div class="v"><em>' + k.rows + '</em></div><div class="k">pre-token rows priced</div></div>' +
      '<div class="kpi"><div class="v">' + k.watchlist_covered + '/' + k.watchlist_total + '</div><div class="k">watchlist covered</div></div>' +
      '<div class="kpi"><div class="v">' + k.median_multiple.toFixed(2) + 'x</div><div class="k">median multiple</div></div>' +
      '<div class="kpi"><div class="v">' + k.wf_miss.toFixed(2) + 'x</div><div class="k">walk-forward miss</div></div>' +
      '<div class="kpi"><div class="v">' + k.slope_per_decade.toFixed(2) + '</div><div class="k">slope per TVL decade</div></div>' +
      '</div>' +
      '<nav class="tabs">' +
      '<button data-nav="board" class="' + (active === 'board' ? 'on' : '') + '">Board</button>' +
      '<button data-nav="validation" class="' + (active === 'validation' ? 'on' : '') + '">Validation</button>' +
      '<button data-nav="method" class="' + (active === 'method' ? 'on' : '') + '">Method</button>' +
      '</nav></header>';
    return h;
  }

  function filteredRows() {
    var rows = R.rows.filter(function (r) {
      if (state.q && (r.name + ' ' + r.slug + ' ' + r.family).toLowerCase().indexOf(state.q) < 0) return false;
      if (state.chain && r.chain !== state.chain) return false;
      if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.conf && r.confidence !== state.conf) return false;
      if (state.wl && !r.watchlist) return false;
      return true;
    });
    var by = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      multiple: function (a, b) { return b.multiple - a.multiple; },
      change: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      deposit: function (a, b) { return b.deposit_usd - a.deposit_usd; }
    };
    return rows.sort(by[state.sort] || by.value);
  }

  function boardView() {
    var chains = {}, cats = {};
    R.rows.forEach(function (r) { chains[r.chain] = 1; cats[r.category || 'Uncategorised'] = 1; });
    var opts = function (obj, cur) {
      return Object.keys(obj).sort().map(function (k2) {
        return '<option value="' + esc(k2) + '"' + (k2 === cur ? ' selected' : '') + '>' + esc(k2) + '</option>';
      }).join('');
    };
    var rows = filteredRows();
    var h = header('board');
    h += '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name, slug, family" value="' + esc(state.q) + '">' +
      '<select id="fchain"><option value="">All chains</option>' + opts(chains, state.chain) + '</select>' +
      '<select id="fcat"><option value="">All categories</option>' + opts(cats, state.category) + '</select>' +
      '<select id="fconf"><option value="">Any confidence</option>' +
      ['high', 'medium', 'low'].map(function (c) {
        return '<option value="' + c + '"' + (state.conf === c ? ' selected' : '') + '>' + c + '</option>';
      }).join('') + '</select>' +
      '<label><input type="checkbox" id="fwl"' + (state.wl ? ' checked' : '') + '> watchlist only</label>' +
      '<select id="fsort">' +
      [['value', 'Sort: implied value'], ['tvl', 'Sort: TVL'], ['multiple', 'Sort: multiple'], ['change', 'Sort: 7d change'], ['deposit', 'Sort: plan deposit']]
        .map(function (o) { return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select>' +
      '<span class="count">' + rows.length + ' of ' + R.rows.length + ' rows</span></div>';
    h += '<table><thead><tr><th class="num">#</th><th class="l">Protocol</th><th class="l">Chain</th><th class="num">TVL</th>' +
      '<th class="num">7d</th><th class="num">Multiple</th><th class="num">Implied value</th><th class="l">80% band</th>' +
      '<th class="l">Confidence</th><th class="num">Plan</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td>' +
        '<td class="l"><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? ' <span class="wl">WL</span>' : '') +
        '<div class="pfam">' + esc(r.family) + '</div></td>' +
        '<td class="l">' + esc(r.chain) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d == null ? '' : r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + mult(r.multiple) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="l band">' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</td>' +
        '<td class="l"><span class="chip ' + r.confidence + '">' + r.confidence + '</span></td>' +
        '<td class="num">$' + r.deposit_usd + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<footer>Implied value = fitted multiple x TVL, the entry\u2019s own claim. The band is the 10\u201390% range of the model\u2019s out-of-fold residuals on the anchors — wide because launch multiples are wide; the point price is the middle of the model, not of the band. Click any row for its dossier and farm plan.</footer>';
    main.innerHTML = h;
    wireBoard();
  }

  function wireBoard() {
    var q = document.getElementById('q');
    q.addEventListener('input', function () { state.q = q.value.toLowerCase(); refreshTable(); });
    document.getElementById('fchain').addEventListener('change', function (e) { state.chain = e.target.value; refreshTable(); });
    document.getElementById('fcat').addEventListener('change', function (e) { state.category = e.target.value; refreshTable(); });
    document.getElementById('fconf').addEventListener('change', function (e) { state.conf = e.target.value; refreshTable(); });
    document.getElementById('fwl').addEventListener('change', function (e) { state.wl = e.target.checked; refreshTable(); });
    document.getElementById('fsort').addEventListener('change', function (e) { state.sort = e.target.value; refreshTable(); });
    wireNav();
    wireRows();
  }
  function refreshTable() {
    var keep = state;
    boardView();
    state = keep;
    var q = document.getElementById('q');
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }
  function wireRows() {
    Array.prototype.forEach.call(main.querySelectorAll('tbody tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/detail/' + tr.getAttribute('data-slug'); });
    });
  }
  function wireNav() {
    Array.prototype.forEach.call(main.querySelectorAll('[data-nav]'), function (b) {
      b.addEventListener('click', function () { location.hash = '#/' + b.getAttribute('data-nav'); });
    });
  }

  function detailView(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) { boardView(); return; }
    var maxF = 0;
    r.decomposition.forEach(function (d) { maxF = Math.max(maxF, Math.abs(Math.log(d.factor))); });
    var h = header('board');
    h += '<div class="detail"><button class="back" id="back">\u2190 Board</button>' +
      '<h2>' + esc(r.name) + ' <span class="chip ' + r.confidence + '">' + r.confidence + ' confidence</span>' +
      (r.watchlist ? ' <span class="wl">on the house watchlist</span>' : '') + '</h2>' +
      '<div class="facts"><span>Family <b>' + esc(r.family) + '</b></span><span>Primary chain <b>' + esc(r.chain) + '</b></span>' +
      '<span>TVL <b>' + money(r.tvl_usd) + '</b></span><span>7d change <b>' + pct(r.change_7d) + '</b></span>' +
      '<span>Tracked since <b>' + esc(r.listed_at || 'unreported') + '</b></span><span>Rank <b>#' + r.rank + '</b></span></div>' +
      '<div><span class="bigval">' + money(r.implied_value_usd) + '</span> <span class="dim">implied value at a fitted multiple of ' +
      mult(r.multiple) + ' — 80% out-of-fold band ' + money(r.implied_low_usd) + ' to ' + money(r.implied_high_usd) + '</span></div>' +
      '<div class="grid2"><div><h3>How the price is built — factor decomposition</h3><div class="decomp">';
    r.decomposition.forEach(function (d) {
      var w = Math.max(2, Math.round(160 * Math.abs(Math.log(d.factor)) / (maxF || 1)));
      h += '<div><span class="lbl">' + esc(d.part) + '</span><span class="bar' + (d.factor < 1 ? ' neg' : '') +
        '" style="width:' + w + 'px"></span><span class="f">x' + d.factor.toFixed(2) + '</span></div>';
    });
    h += '</div><p class="note">The factors multiply to the row\u2019s multiple. Offsets are group mean residuals shrunk toward 1.00 by the DerSimonian\u2013Laird factor, so a family with two anchors barely moves a price and one with twenty moves it almost fully.</p>' +
      '<h3 style="margin-top:16px">Family record</h3><p class="note" style="margin-top:0">' +
      (r.family_record.n > 0
        ? 'This family holds <b>' + r.family_record.n + '</b> traded anchor(s). ' +
          (r.family_record.loo_miss == null
            ? 'That is too thin a record to grade leave-one-out, so the confidence rests on the headcount and the TVL range alone — and stays low.'
            : 'Graded leave-one-out — each anchor priced by a model that never saw it — the ' +
              r.family_record.basis + ' record\u2019s typical miss is <b>' + r.family_record.loo_miss.toFixed(2) + 'x</b>. ' +
              'Confidence is ruled from that record, the family\u2019s headcount and whether the row\u2019s TVL sits inside the anchors\u2019 range; it is never hand-set.')
        : 'No traded anchor shares this family yet, so the price rests on the category and chain levels and the global line — the widest-error case this model has, and the confidence chip says so.') +
      '</p></div>' +
      '<div><h3>Farm plan — deposit $' + r.deposit_usd + '</h3><ol class="plan">';
    r.farm_steps.forEach(function (s) { h += '<li>' + esc(s) + '</li>'; });
    h += '</ol></div></div>';
    if (r.peers.length) {
      h += '<h3 style="margin-top:18px">Traded peers in the family</h3><table class="peers"><thead><tr><th class="l">Protocol</th><th class="num">TVL</th><th class="num">Actual multiple</th></tr></thead><tbody>';
      r.peers.forEach(function (p) {
        h += '<tr><td class="l">' + esc(p.name) + '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + mult(p.multiple) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '</div>';
    main.innerHTML = h;
    document.getElementById('back').addEventListener('click', function () { location.hash = '#/board'; });
    wireNav();
  }

  function validationView() {
    var h = header('validation');
    h += '<p class="dim" style="max-width:920px">Every pricing below is refitted inside each split; nothing is graded on data it was fitted on. ' +
      'Miss is the median fold error (a miss of 2.00x means the typical prediction is off by a factor of two, either way); within-2x is the share of graded anchors priced inside a factor of two.</p>';
    h += '<table class="val"><thead><tr><th class="l">Pricing</th><th colspan="4">Walk-forward by listing date (fit 47, grade 48)</th>' +
      '<th colspan="4">Interleaved by slug (fit 64, grade 64)</th><th colspan="4">Leave-one-out (128)</th></tr>' +
      '<tr><th></th>' + '<th>miss</th><th>med err</th><th>bias</th><th>w2x</th>'.repeat(3) + '</tr></thead><tbody>';
    R.validation.forEach(function (v, i) {
      h += '<tr' + (i === 0 ? ' class="win"' : '') + '><td class="l">' + esc(v.pricing) + '</td>' + score(v.wf) + score(v.interleaved) + score(v.loo) + '</tr>';
    });
    h += '</tbody></table>';
    var e = R.expanding;
    h += '<p style="margin-top:14px">Expanding-window walk-forward (three temporal folds, every graded anchor newer than every fitted one, n=' + e.n + '): ' +
      'miss <b>' + e.miss.toFixed(2) + 'x</b>, median error ' + e.medErr.toFixed(3) + ', within-2x ' + (e.within2 * 100).toFixed(0) + '%.</p>';
    h += '<h3 style="margin-top:20px">Segment record — leave-one-out miss by chain and category (groups of 3+ anchors)</h3>' +
      '<table class="val"><thead><tr><th class="l">Segment</th><th class="l">Kind</th><th>Anchors</th><th>Miss</th><th>Med err</th></tr></thead><tbody>';
    R.segments.forEach(function (s) {
      h += '<tr><td class="l">' + esc(s.name) + '</td><td class="l">' + s.kind + '</td><td class="num">' + s.n + '</td><td class="num">' + s.miss.toFixed(2) + 'x</td><td class="num">' + s.med_err.toFixed(3) + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<footer>The ladder, category-median and global-median rows are the honest baselines: the fitted model has to beat them out of sample, on the splits above, or it would not be the board\u2019s pricing.</footer>';
    main.innerHTML = h;
    wireNav();
  }

  function methodView() {
    var c = R.census;
    var h = header('method');
    h += '<div class="method">' +
      '<h3>The census — every protocol accounted for</h3>' +
      '<p>Of the snapshot\u2019s 758 protocols: <b>' + c.anchor + '</b> are anchors (a token trades, with a market cap and positive TVL), ' +
      '<b>' + c.trading + '</b> trade but carry no usable cap and are set aside, <b>' + c.excluded + '</b> are pre-token products of tokens that already trade ' +
      '(wrapped, staked, versioned, bridge, liquid-staking or exchange products) and are excluded, and <b>' + c.candidate + '</b> are the priced candidates on the board. ' +
      'All ' + R.kpis.watchlist_total + ' watchlist protocols are on the board; the watchlist is a floor, not the board.</p>' +
      '<h3>The model</h3>' +
      '<p>For the anchors, log(market cap / TVL) is regressed on standardised log10(TVL) (slope <b>' + R.kpis.slope_per_decade.toFixed(2) +
      ' per decade of TVL</b>), a log-age term (days since the protocol was first tracked), chain, family (category x primary chain) and category offsets, ' +
      'and a per-category slope deviation. Offsets are group mean residuals shrunk by the DerSimonian\u2013Laird factor tau\u00B2/(tau\u00B2 + s\u00B2/n); the line and offsets are fitted ' +
      'together by three rounds of backfitting with a ridge on the slopes; the resolved multiple is clamped to [0.03, 2.5]. No protocol is priced by name: move its TVL, age, chain or category and its price moves.</p>' +
      '<h3>What v7 changed, and what it dropped</h3>' +
      '<p>The age term, the per-category slopes and the third backfitting round are new in this version, and each is here because it lowered the walk-forward miss on all three splits ' +
      '(2.94x to ' + R.kpis.wf_miss.toFixed(2) + 'x on the headline split). Two ideas were built, graded and dropped: a seven-day TVL-change regressor, and a calibration that shrank point ' +
      'predictions toward the mean — both graded worse out of sample, so neither ships. The ensemble with the family ladder was also graded and dropped: the ladder is the weaker pricing and blending dragged the fit down.</p>' +
      '<h3>Intervals and confidence</h3>' +
      '<p>Each row\u2019s band is its point price shifted by the 10th and 90th percentiles of the model\u2019s five-fold out-of-fold residuals on the anchors — an honest 80% band for a quantity ' +
      'whose out-of-fold typical miss is ' + R.kpis.oof_miss.toFixed(2) + 'x. Confidence is a stated rule, not a feeling: high needs 3+ family anchors, a family leave-one-out miss at or under 3.0x ' +
      'and a TVL inside the anchors\u2019 range; medium needs a family record at or under 3.5x, or a category record at or under 3.2x on 5+ anchors; the rest is low. ' +
      'This board carries ' + R.confidence_counts.high + ' high, ' + R.confidence_counts.medium + ' medium and ' + R.confidence_counts.low + ' low rows.</p>' +
      '<h3>Farm plans</h3>' +
      '<p>Each plan sizes its deposit to the protocol\u2019s TVL band, costs gas by its primary chain\u2019s class, words its core step by category, and states a hold rule, a monthly re-read and a risk cap. ' +
      'A plan is a starting position to verify against the live product, not financial advice.</p>' +
      '</div>';
    main.innerHTML = h;
    wireNav();
  }

  function route() {
    var hash = location.hash || '#/board';
    var parts = hash.replace(/^#\//, '').split('/');
    if (parts[0] === 'detail' && parts[1]) detailView(decodeURIComponent(parts[1].split('?')[0]));
    else if (parts[0] === 'validation') validationView();
    else if (parts[0] === 'method') methodView();
    else {
      // A board link may carry an initial filter: #/board?chain=Ethereum
      var qAt = hash.indexOf('?');
      if (qAt >= 0) {
        hash.slice(qAt + 1).split('&').forEach(function (kv) {
          var pair = kv.split('=');
          var key = pair[0], val = decodeURIComponent(pair[1] || '');
          if (key === 'chain') state.chain = val;
          if (key === 'category') state.category = val;
          if (key === 'conf') state.conf = val;
          if (key === 'q') state.q = val.toLowerCase();
          if (key === 'wl') state.wl = val === '1';
          if (key === 'sort') state.sort = val;
        });
      }
      boardView();
    }
    main.setAttribute('aria-busy', 'false');
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();
})();
