/**
 * JournUp Price Alerts — Cloudflare Worker
 * Deploy via Cloudflare Dashboard — no CLI needed.
 * Nothing is hardcoded. All config comes from the HTML page via /config POST.
 *
 * Config keys pushed from the page:
 *   telegramToken, telegramChatId   — from the Telegram setup panel
 *   discordWebhook                  — from the Discord setup panel
 *   discordFooter, discordTitlePrefix, discordColorAbove, discordColorBelow — Discord embed options
 *   msgTemplate, msgDirAbove, msgDirBelow, notePrefix, datetimeFmt          — shared message template
 *   avKey, oandaKey, oandaEnv, finnhubKey, coingeckoKey                     — data provider keys
 *   knownCrypto, commodities, indices, providerChain                        — asset classification
 */

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
    'Access-Control-Max-Age': '86400',
  };
}
function jsonRes(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
  });
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', function(event) {
  event.waitUntil(paCheckAll());
});

async function handleRequest(request) {
  var origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (typeof WORKER_SECRET !== 'undefined' && WORKER_SECRET) {
    if ((request.headers.get('X-Worker-Secret') || '') !== WORKER_SECRET) {
      return jsonRes({ error: 'Unauthorized' }, 401, origin);
    }
  }
  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/, '');
  var method = request.method;

  if (path === '/config' && method === 'POST') {
    var body = await request.json().catch(function() { return null; });
    if (!body) return jsonRes({ error: 'Invalid JSON' }, 400, origin);
    await JOURNUP_KV.put('config', JSON.stringify(body));
    return jsonRes({ ok: true }, 200, origin);
  }
  if (path === '/config' && method === 'GET') {
    var raw = await JOURNUP_KV.get('config');
    if (!raw) return jsonRes({ error: 'Not configured' }, 404, origin);
    return jsonRes(JSON.parse(raw), 200, origin);
  }
  if (path === '/alerts' && method === 'POST') {
    var body = await request.json().catch(function() { return null; });
    if (!Array.isArray(body)) return jsonRes({ error: 'Expected array' }, 400, origin);
    await JOURNUP_KV.put('alerts', JSON.stringify(body));
    return jsonRes({ ok: true, count: body.length }, 200, origin);
  }
  if (path === '/alerts' && method === 'GET') {
    var raw = await JOURNUP_KV.get('alerts');
    return jsonRes(raw ? JSON.parse(raw) : [], 200, origin);
  }
  if (path === '/trigger_log' && method === 'GET') {
    var raw = await JOURNUP_KV.get('trigger_log');
    return jsonRes(raw ? JSON.parse(raw) : [], 200, origin);
  }
  if (path === '/poll' && method === 'POST') {
    // Run paCheckAll() directly and await it so the response includes the result.
    // (event.waitUntil is not available inside handleRequest scope)
    try {
      await paCheckAll();
      return jsonRes({ ok: true, message: 'Poll completed' }, 200, origin);
    } catch(e) {
      return jsonRes({ ok: false, error: e.message }, 500, origin);
    }
  }
  if (path === '/status' && method === 'GET') {
    var cfgRaw = await JOURNUP_KV.get('config');
    var alertsRaw = await JOURNUP_KV.get('alerts');
    var alerts = alertsRaw ? JSON.parse(alertsRaw) : [];
    return jsonRes({ ok: true, configured: !!cfgRaw, totalAlerts: alerts.length, activeAlerts: alerts.filter(function(a) { return !a.fired; }).length }, 200, origin);
  }
  if (path === '/debug' && method === 'GET') {
    var sym = url.searchParams.get('sym') || 'BTCUSDT';
    var cfgRaw2 = await JOURNUP_KV.get('config');
    var cfg2 = cfgRaw2 ? JSON.parse(cfgRaw2) : {};
    var provChain = (cfg2.providerChain) || DEFAULT_PROVIDER_CHAIN;
    var results = { sym: sym, assetType: detectAssetType(sym, cfg2), providerChain: provChain[detectAssetType(sym, cfg2)] };
    try { results.binance = await fetchBinance(sym); } catch(e) { results.binance = 'ERR: ' + e.message; }
    try { results.coingecko = await fetchCoinGecko(sym, cfg2.coingeckoKey); } catch(e) { results.coingecko = 'ERR: ' + e.message; }
    try { results.yahoo = await fetchYahoo(sym); } catch(e) { results.yahoo = 'ERR: ' + e.message; }
    if (cfg2.avKey) {
      try { results.av = await fetchAlphaVantage(sym, cfg2.avKey); } catch(e) { results.av = 'ERR: ' + e.message; }
    } else { results.av = 'no key'; }
    if (cfg2.oandaKey) {
      try { results.oanda = await fetchOanda(sym, cfg2.oandaKey, cfg2.oandaEnv || 'practice'); } catch(e) { results.oanda = 'ERR: ' + e.message; }
    } else { results.oanda = 'no key'; }
    if (cfg2.finnhubKey) {
      try { results.finnhub = await fetchFinnhub(sym, cfg2.finnhubKey); } catch(e) { results.finnhub = 'ERR: ' + e.message; }
    } else { results.finnhub = 'no key'; }
    try { results.fetchPriceWithMeta = await fetchPriceWithMeta(sym, cfg2); } catch(e) { results.fetchPriceWithMeta = 'ERR: ' + e.message; }
    return jsonRes(results, 200, origin);
  }
  if (path === '/prices' && method === 'GET') {
    var raw = await JOURNUP_KV.get('prices');
    return jsonRes(raw ? JSON.parse(raw) : {}, 200, origin);
  }
  // Live price fetch — no KV read/write, result returned directly to browser
  if (path === '/price' && method === 'GET') {
    var sym = url.searchParams.get('symbol') || '';
    if (!sym) return jsonRes({ error: 'Missing symbol parameter' }, 400, origin);
    var cfgRaw = await JOURNUP_KV.get('config');
    var cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
    try {
      var result = await fetchPriceWithMeta(sym.toUpperCase(), cfg);
      if (result === null) return jsonRes({ error: 'Price unavailable' }, 502, origin);
      return jsonRes({ symbol: sym.toUpperCase(), price: result.price, provider: result.provider, time: Date.now() }, 200, origin);
    } catch(e) {
      return jsonRes({ error: e.message }, 502, origin);
    }
  }
  return jsonRes({ error: 'Not found' }, 404, origin);
}

async function paCheckAll() {
  var cfgRaw = await JOURNUP_KV.get('config');
  if (!cfgRaw) return;
  var cfg = JSON.parse(cfgRaw);
  // Poll interval is controlled entirely by the Cloudflare cron trigger
  // in the dashboard — no throttle guard needed here.
  var alertsRaw = await JOURNUP_KV.get('alerts');
  if (!alertsRaw) return;
  var alerts = JSON.parse(alertsRaw);
  var active = alerts.filter(function(a) { return !a.fired; });
  if (!active.length) return;
  var bySymbol = {};
  active.forEach(function(a) { if (!bySymbol[a.symbol]) bySymbol[a.symbol] = []; bySymbol[a.symbol].push(a); });
  var changed = false;
  var logEntries = [];

  await Promise.all(Object.keys(bySymbol).map(async function(sym) {
    var result = await fetchPriceWithMeta(sym, cfg);
    if (result === null) return;
    var price = result.price;
    var symAlerts = bySymbol[sym];
    for (var i = 0; i < symAlerts.length; i++) {
      var a = symAlerts[i];
      var hit = (a.dir === 'above' && price >= a.target) || (a.dir === 'below' && price <= a.target);
      if (!hit) continue;
      var idx = alerts.findIndex(function(x) { return x.id === a.id; });
      if (idx !== -1) { alerts[idx].fired = true; alerts[idx].firedAt = Date.now(); alerts[idx].firedPrice = price; }
      changed = true;
      var tgMsgId = await sendTelegram(buildMessage(a, price, cfg), cfg);
      if (tgMsgId && idx !== -1) alerts[idx].tgMessageId = tgMsgId;
      if (cfg.discordWebhook) await sendDiscord(buildDiscordEmbed(a, price, cfg), cfg.discordWebhook);
      logEntries.push({ id: a.id, symbol: a.symbol, dir: a.dir, target: a.target, price: price, note: a.note || '', firedAt: Date.now() });
    }
  }));
  if (changed) await JOURNUP_KV.put('alerts', JSON.stringify(alerts));
  if (logEntries.length) {
    var existingRaw = await JOURNUP_KV.get('trigger_log');
    var log = (existingRaw ? JSON.parse(existingRaw) : []).concat(logEntries).slice(-200);
    await JOURNUP_KV.put('trigger_log', JSON.stringify(log));
  }
}

// Default asset-detection lists — kept in sync with the page's paDetectAssetType.
// If the page sends cfg.knownCrypto / cfg.commodities / cfg.indices in the config
// payload, those override these defaults so the page stays the single source of truth.
var DEFAULT_KNOWN_CRYPTO = ['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','AVAX','DOT','MATIC','LTC','LINK','UNI','ATOM','TRX','TON','SHIB'];
var DEFAULT_COMMODITIES  = ['XAUUSD','XAGUSD','GOLD','SILVER','OIL','CRUDE','WTI','BRENT','NATGAS','CORN','WHEAT'];
var DEFAULT_INDICES      = ['US30','US500','SP500','SPX','NAS100','NASDAQ','DAX','UK100','GDAXI','YM=F','ES=F','NQ=F'];

// Default provider chains — overrideable via cfg.providerChain sent from the page.
var DEFAULT_PROVIDER_CHAIN = {
  crypto:    ['binance','coingecko','yahoo'],
  forex:     ['oanda','av','yahoo'],
  commodity: ['oanda','av','yahoo'],
  stock:     ['finnhub','av','yahoo'],
  index:     ['finnhub','av','yahoo']
};

function detectAssetType(sym, cfg) {
  var u = sym.toUpperCase();
  var crypto      = (cfg && cfg.knownCrypto)  || DEFAULT_KNOWN_CRYPTO;
  var commodities = (cfg && cfg.commodities)  || DEFAULT_COMMODITIES;
  var indices     = (cfg && cfg.indices)      || DEFAULT_INDICES;
  if (/^[A-Z]+USDT$/.test(u)) return 'crypto';
  if (crypto.indexOf(u) !== -1) return 'crypto';
  if (/^[A-Z]+USD$/.test(u) && crypto.indexOf(u.slice(0,-3)) !== -1) return 'crypto';
  if (commodities.indexOf(u) !== -1) return 'commodity';
  if (indices.indexOf(u) !== -1) return 'index';
  if (/^[A-Z]{6}$/.test(u)) return 'forex';
  return 'stock';
}

async function fetchPriceWithMeta(sym, cfg) {
  var providerChain = (cfg && cfg.providerChain) || DEFAULT_PROVIDER_CHAIN;
  var chain = providerChain[detectAssetType(sym, cfg)] || ['yahoo'];
  for (var i = 0; i < chain.length; i++) {
    var p = chain[i];
    if (p === 'av' && !cfg.avKey) continue;
    if (p === 'oanda' && !cfg.oandaKey) continue;
    if (p === 'finnhub' && !cfg.finnhubKey) continue;
    try {
      var price = null;
      if (p === 'binance')   price = await fetchBinance(sym);
      if (p === 'coingecko') price = await fetchCoinGecko(sym, cfg.coingeckoKey);
      if (p === 'yahoo')     price = await fetchYahoo(sym);
      if (p === 'av')        price = await fetchAlphaVantage(sym, cfg.avKey);
      if (p === 'oanda')     price = await fetchOanda(sym, cfg.oandaKey, cfg.oandaEnv || 'practice');
      if (p === 'finnhub')   price = await fetchFinnhub(sym, cfg.finnhubKey);
      if (price !== null && !isNaN(price)) return { price: price, provider: p };
    } catch(e) {}
  }
  return null;
}

async function fetchPrice(sym, cfg) {
  var result = await fetchPriceWithMeta(sym, cfg);
  return result ? result.price : null;
}

async function fetchBinance(sym) {
  var u = sym.toUpperCase();
  var pair = /USDT$/.test(u) ? u : u.replace(/USD$/,'') + 'USDT';
  var d = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + pair)).json();
  return d.price ? parseFloat(d.price) : null;
}

var CG_MAP = {'BTC':'bitcoin','BTCUSDT':'bitcoin','ETH':'ethereum','ETHUSDT':'ethereum','BNB':'binancecoin','BNBUSDT':'binancecoin','SOL':'solana','SOLUSDT':'solana','XRP':'ripple','XRPUSDT':'ripple','ADA':'cardano','ADAUSDT':'cardano','DOGE':'dogecoin','DOGEUSDT':'dogecoin','AVAX':'avalanche-2','AVAXUSDT':'avalanche-2','DOT':'polkadot','DOTUSDT':'polkadot','LTC':'litecoin','LTCUSDT':'litecoin','LINK':'chainlink','LINKUSDT':'chainlink','TON':'the-open-network','TONUSDT':'the-open-network','SHIB':'shiba-inu','SHIBUSDT':'shiba-inu'};
async function fetchCoinGecko(sym, apiKey) {
  var u = sym.toUpperCase();
  var id = CG_MAP[u] || u.replace(/USDT$|USD$/,'').toLowerCase();
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + encodeURIComponent(id) + '&vs_currencies=usd';
  if (apiKey) url += '&x_cg_demo_api_key=' + encodeURIComponent(apiKey);
  var d = await (await fetch(url)).json();
  return (d[id] && d[id].usd) ? parseFloat(d[id].usd) : null;
}

var YAHOO_MAP = {'GOLD':'GC=F','SILVER':'SI=F','OIL':'CL=F','WTI':'CL=F','BRENT':'BZ=F','US30':'YM=F','US500':'ES=F','SP500':'ES=F','SPX':'ES=F','NAS100':'NQ=F','XAUUSD':'GC=F','XAGUSD':'SI=F','EURUSD':'EURUSD=X','GBPUSD':'GBPUSD=X','USDJPY':'USDJPY=X','AUDUSD':'AUDUSD=X','USDCAD':'USDCAD=X','USDCHF':'USDCHF=X'};
async function fetchYahoo(sym) {
  var u = sym.toUpperCase();
  var ticker = YAHOO_MAP[u] || u;
  if (!YAHOO_MAP[u] && /^[A-Z]{6}$/.test(u)) ticker = u + '=X';
  // Call Yahoo directly — no CORS proxy needed from a Worker (server-side)
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?interval=1m&range=1d';
  var r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JournUp/1.0)',
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    // Try query2 as fallback if query1 rate-limits
    var r2 = await fetch(url.replace('query1', 'query2'), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JournUp/1.0)', 'Accept': 'application/json' }
    });
    if (!r2.ok) return null;
    r = r2;
  }
  var d = await r.json();
  var meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  return (meta && meta.regularMarketPrice) ? parseFloat(meta.regularMarketPrice) : null;
}

var AV_COMM = {'GOLD':'XAUUSD','SILVER':'XAGUSD','XAUUSD':'XAUUSD','XAGUSD':'XAGUSD'};
async function fetchAlphaVantage(sym, apiKey) {
  var u = sym.toUpperCase();
  if (/^[A-Z]{6}$/.test(u) || AV_COMM[u]) {
    var pair = AV_COMM[u] || u;
    var d = await (await fetch('https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=' + pair.slice(0,3) + '&to_currency=' + pair.slice(3,6) + '&apikey=' + encodeURIComponent(apiKey))).json();
    var rate = d['Realtime Currency Exchange Rate'] && d['Realtime Currency Exchange Rate']['5. Exchange Rate'];
    return rate ? parseFloat(rate) : null;
  }
  var d = await (await fetch('https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=' + encodeURIComponent(u) + '&apikey=' + encodeURIComponent(apiKey))).json();
  var price = d['Global Quote'] && d['Global Quote']['05. price'];
  return price ? parseFloat(price) : null;
}

var OANDA_MAP = {'EURUSD':'EUR_USD','GBPUSD':'GBP_USD','USDJPY':'USD_JPY','AUDUSD':'AUD_USD','USDCAD':'USD_CAD','USDCHF':'USD_CHF','NZDUSD':'NZD_USD','EURGBP':'EUR_GBP','EURJPY':'EUR_JPY','GBPJPY':'GBP_JPY','XAUUSD':'XAU_USD','XAGUSD':'XAG_USD','GOLD':'XAU_USD','SILVER':'XAG_USD','US30':'US30_USD','US500':'SPX500_USD','SP500':'SPX500_USD','NAS100':'NAS100_USD','OIL':'WTICO_USD','WTI':'WTICO_USD','CRUDE':'WTICO_USD','BRENT':'BCO_USD'};
async function fetchOanda(sym, apiKey, env) {
  var u = sym.toUpperCase();
  var inst = OANDA_MAP[u] || (/^[A-Z]{6}$/.test(u) ? u.slice(0,3)+'_'+u.slice(3,6) : (/^[A-Z]+_[A-Z]+$/.test(u) ? u : null));
  if (!inst) return null;
  var host = env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
  var r = await fetch(host + '/v3/instruments/' + inst + '/candles?count=1&price=M&granularity=S5', { headers: { 'Authorization': 'Bearer ' + apiKey } });
  if (!r.ok) return null;
  var d = await r.json();
  var price = d.candles && d.candles.length && parseFloat(d.candles[d.candles.length-1].mid.c);
  return (price && !isNaN(price)) ? price : null;
}

var FINNHUB_MAP = {'US30':'DJI','SP500':'^GSPC','SPX':'^GSPC','US500':'^GSPC','NAS100':'^NDX','NASDAQ':'^NDX','DAX':'^GDAXI','UK100':'^FTSE','GOLD':'OANDA:XAU_USD','XAUUSD':'OANDA:XAU_USD','SILVER':'OANDA:XAG_USD','XAGUSD':'OANDA:XAG_USD'};
async function fetchFinnhub(sym, apiKey) {
  var ticker = FINNHUB_MAP[sym.toUpperCase()] || sym.toUpperCase();
  var d = await (await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(apiKey))).json();
  return (d.c && d.c !== 0) ? parseFloat(d.c) : null;
}

function fmtPrice(p) {
  if (p === null || p === undefined) return '—';
  var s = parseFloat(p).toString(), parts = s.split('.');
  return (parts.length > 1 ? parseInt(parts[0],10).toLocaleString() + '.' + parts[1] : parseInt(parts[0],10).toLocaleString());
}

function fmtDatetime(fmt) {
  var now = new Date();
  if (fmt === 'iso')       return now.toISOString();
  if (fmt === 'date-only') return now.toISOString().slice(0, 10);
  if (fmt === 'time-only') return now.toISOString().slice(11, 16) + ' UTC';
  // 'locale' or unset — use a readable UTC string (Workers have no locale context)
  return now.toUTCString().replace(' GMT', ' UTC');
}

function buildMessage(a, price, cfg) {
  var dir        = a.dir === 'above' ? (cfg.msgDirAbove || '📈 rose above') : (cfg.msgDirBelow || '📉 dropped below');
  var notePrefix = cfg.notePrefix !== undefined ? cfg.notePrefix : '📝 ';
  var note       = a.note ? '\n' + notePrefix + a.note : '';
  var tpl = cfg.msgTemplate || '🔔 <b>Price Alert Triggered!</b>\n\n<b>{symbol}</b> {direction} <b>{target}</b>\nCurrent price: <b>{price}</b>{note}\n<i>🕐 {datetime}</i>\n<i>— JournUp Price Alerts (cloud)</i>';
  var datetime   = fmtDatetime(cfg.datetimeFmt);
  return tpl.replace(/\{symbol\}/g, a.symbol).replace(/\{direction\}/g, dir).replace(/\{target\}/g, fmtPrice(a.target)).replace(/\{price\}/g, fmtPrice(price)).replace(/\{note\}/g, note).replace(/\{datetime\}/g, datetime);
}

function buildDiscordEmbed(a, price, cfg) {
  var notePrefix  = cfg && cfg.notePrefix !== undefined ? cfg.notePrefix : '📝 ';
  var colorAbove  = cfg && cfg.discordColorAbove ? parseInt(cfg.discordColorAbove.replace('#',''), 16) : 0x34c97a;
  var colorBelow  = cfg && cfg.discordColorBelow ? parseInt(cfg.discordColorBelow.replace('#',''), 16) : 0xe85555;
  var footerText  = (cfg && cfg.discordFooter) || 'JournUp Price Alerts (cloud)';
  var titlePrefix = (cfg && cfg.discordTitlePrefix) || '🔔 Price Alert: ';
  var fields = [{ name:'Direction', value: a.dir==='above'?'↑ Above':'↓ Below', inline:true },{ name:'Target', value:fmtPrice(a.target), inline:true },{ name:'Current', value:fmtPrice(price), inline:true }];
  if (a.note) fields.push({ name: notePrefix ? notePrefix.trim() || 'Note' : 'Note', value: a.note });
  return { embeds:[{ title: titlePrefix + a.symbol, color: a.dir==='above' ? colorAbove : colorBelow, fields:fields, footer:{text: footerText}, timestamp:new Date().toISOString() }] };
}

async function sendTelegram(text, cfg) {
  if (!cfg.telegramToken || !cfg.telegramChatId) return null;
  var r = await fetch('https://api.telegram.org/bot' + cfg.telegramToken + '/sendMessage', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:cfg.telegramChatId, text:text, parse_mode:'HTML' }) });
  var d = await r.json().catch(function(){ return {}; });
  return (d.ok && d.result) ? d.result.message_id : null;
}
async function sendDiscord(payload, webhookUrl) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
}
