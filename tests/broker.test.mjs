// Проверка раздельного отображения брокеров и скрытия переключателя.
// Запуск: node tests/broker.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const adapter = readFileSync(new URL('../supabase-adapter.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function sourceOf(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name}() не найдена`);
  let depth = 0, opened = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (c === '{') { depth++; opened = true; }
    else if (c === '}') { depth--; if (opened && depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`не сбалансированы скобки в ${name}()`);
}

function makeContext(rows) {
  const store = {};
  const host = {
    hidden: true, innerHTML: '',
    querySelectorAll() { return []; }
  };
  const calls = [];
  const client = {
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    rpc(name, args) { calls.push([name, args]); return Promise.resolve({ data: null, error: null }); },
    from(table) {
      let filters = {};
      const q = {
        select() { return q; },
        eq(k, v) { filters[k] = v; return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() { return q; },
        then(resolve) {
          let data = rows[table] || [];
          Object.keys(filters).forEach(k => {
            data = data.filter(r => String(r[k]) === String(filters[k]));
          });
          return Promise.resolve({ data, error: null }).then(resolve);
        }
      };
      return q;
    }
  };
  const connect = { hidden: true, cloneNode() { return this; }, addEventListener() {}, parentNode: { replaceChild() {} } };
  const ctx = {
    console,
    localStorage: {
      getItem: k => store[k] || null,
      setItem: (k, v) => { store[k] = v; },
    },
    document: {
      querySelector: () => null,
      getElementById: id => id === 'brokerSwitch' ? host : id === 'btnConnectBroker' ? connect : null,
    },
    setTimeout, clearTimeout,
    state: { quotes: {}, settings: {}, goals: [] },
    currentAccount: { id: 'user-1' },
    scheduleServerSave() {},
    renderAll() {},
    refreshMarket: () => Promise.resolve(true),
  };
  ctx.window = { supabase: { createClient: () => client } };
  vm.createContext(ctx);
  vm.runInContext(sourceOf('normalizeReport'), ctx);
  vm.runInContext(adapter, ctx);
  ctx.__rpcCalls = calls;
  return { ctx, host, store, connect };
}

function payload(name) {
  return {
    period: { from: '2026-10-01', to: '2026-11-26' },
    positions: [{ name, isin: name, qty: 1, price: 100, value: 100 }],
    trades: [], cashflow: [], assets: [], reference: []
  };
}

const rows = {
  app_settings: [],
  goals: [],
  quotes: [
    { user_id: 'user-1', broker: 'sber', ticker: 'SBER', secid: 'SBER', price: 290, accrued: 0 },
    { user_id: 'user-1', broker: 'tinvest', ticker: 'T', secid: 'T', price: 310, accrued: 0 },
  ],
  positions: [{ user_id: 'user-1', broker: 'sber', isin: 'SBER', ticker: 'SBER', count: 1, avg_price: 280 }],
  reports: [
    { user_id: 'user-1', broker: 'sber', period_from: '2026-10-01', period_to: '2026-11-26', payload: payload('Сбер') },
    { user_id: 'user-1', broker: 'tinvest', period_from: '2026-10-01', period_to: '2026-11-26', payload: payload('Тинвест') },
  ],
  transactions: [],
  broker_accounts: [{ user_id: 'user-1', broker: 'tinvest', account_id: 'acc-1', enabled: true, status: 'ok' }],
};

const { ctx, host, connect } = makeContext(rows);
assert.equal(ctx.window.getAvailableBrokers().join(','), 'sber', 'до загрузки брокер по умолчанию');
await ctx.loadServerState();
assert.equal(ctx.window.getAvailableBrokers().join(','), 'sber,tinvest');
assert.equal(host.hidden, false, 'переключатель виден при двух брокерах');
assert.match(host.innerHTML, /Сбер/);
assert.match(host.innerHTML, /Инвестиции/);
assert.equal(connect.hidden, true, 'кнопка подключения скрыта, когда брокер уже подключён');
assert.equal(ctx.state.report.positions[0].name, 'Сбер');
assert.ok(ctx.state.quotes.SBER, 'котировки Сбера загружены');

assert.equal(ctx.window.setActiveBroker('tinvest'), true);
await ctx.loadServerState();
assert.equal(ctx.state.report.positions[0].name, 'Тинвест');
assert.ok(ctx.state.quotes.T, 'котировки Т‑Инвестиций загружены');
assert.equal(ctx.state.quotes.SBER, undefined, 'котировки другого брокера не смешиваются');

const one = makeContext({
  ...rows,
  reports: [rows.reports[0]],
  broker_accounts: [],
});
await one.ctx.loadServerState();
assert.equal(one.ctx.window.getAvailableBrokers().join(','), 'sber');
assert.equal(one.host.hidden, true, 'переключатель скрыт, если брокер один');
assert.equal(one.connect.hidden, false, 'кнопка подключения видна, если только Сбер');
assert.equal(typeof one.ctx.supabaseRpc, 'undefined');

console.log('OK: брокеры разделены, переключатель скрыт при одном брокере');
