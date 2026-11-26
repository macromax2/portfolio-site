// Регрессионный тест расчёта P/L по всем эмитентам.
// Запуск: node tests/pl.test.mjs
//
// Ловит исходную ошибку: «грязная» рыночная стоимость (чистая цена + НКД)
// сравнивалась с «чистой» себестоимостью — из-за этого ОФЗ 26248 с НКД 117 ₽
// показывал фиктивные +7,87% вместо +0,30%.
//
// Главная инварианта: P/L не должен меняться при изменении НКД.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sourceOf(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name}() не найдена в index.html`);
  let depth = 0, opened = false;
  for (let i = start; i < html.length; i++){
    const c = html[i];
    if (c === '{'){ depth++; opened = true; }
    else if (c === '}'){ depth--; if (opened && depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`не сбалансированы скобки в ${name}()`);
}

// Все 5 эмитентов отчёта Сбера за 25.11.2026 + живые котировки MOEX.
const positions = [
  { name:'БПИФ Ликвидность УК ВИМ', isin:'RU000A1014L8', qty:394, value:843.9128, 'nkд':0 },
  { name:'МэйлБ1Р2',               isin:'RU000A10EXJ3',   qty:1,   value:997.9,    'nkд':3.1 },
  { name:'ОФЗ 26247',              isin:'RU000A108EF8',   qty:2,   value:1570.9,   'nkд':0 },
  { name:'ОФЗ 26248',              isin:'RU000A108EH4',   qty:2,   value:1561.78,  'nkд':117.46 },
  { name:'Сбербанк России',        isin:'RU0009029540',   qty:2,   value:574.84,   'nkд':0 },
];
const prices  = { RU000A1014L8:2.1427, RU000A10EXJ3:991.9, RU000A108EF8:785.6,
                  RU000A108EH4:782.4, RU0009029540:286.44 };
const accrued = { RU000A1014L8:0, RU000A10EXJ3:3.1, RU000A108EF8:0.3356044,
                  RU000A108EH4:59.0663736, RU0009029540:0 };
const costs   = { RU000A1014L8:844.0, RU000A10EXJ3:998.59, RU000A108EF8:1571.78,
                  RU000A108EH4:1560.16, RU0009029540:570.6 };

const cb = Object.fromEntries(
  Object.entries(costs).map(([k, cost]) => [k, { cost, qty:1 }])
);

function makeMetrics(accruedFn){
  const ctx = {
    posKey: p => p.isin,
    quoteOf: k => prices[k] ?? null,
    accruedOf: accruedFn,
    todayISO: () => '2026-11-26',
  };
  vm.createContext(ctx);
  vm.runInContext(sourceOf('positionMetrics'), ctx);
  return p => ctx.positionMetrics(p, cb, '2026-11-26');
}

const metrics = makeMetrics((k) => accrued[k] ?? 0);
const rows = positions.map(metrics);
let checks = 0;

for (const [i, r] of rows.entries()){
  const p = positions[i];
  // Чистая стоимость, НКД и «грязная» стоимость не смешиваются.
  assert.ok(Math.abs(r.clean - (p.qty * prices[p.isin])) < 1e-6, `${p.name}: чистая цена`);
  assert.ok(Math.abs(r.value - (r.clean + r.nkd)) < 1e-6, `${p.name}: грязная стоимость`);
  assert.ok(Math.abs(r.pl - (r.clean - r.cost)) < 1e-6, `${p.name}: P/L = чистая − себестоимость`);
  checks += 3;

  // Ни у одной бумаги НКД не превращается в прибыль.
  assert.ok(Math.abs(r.plp) < 1, `${p.name}: подозрительная доходность ${r.plp.toFixed(2)}%`);
  checks++;
}

// Ключевая инварианта: сколько бы ни был НКД, P/L не меняется.
for (const zero of [makeMetrics(() => 0), makeMetrics(() => 100000)]){
  for (const [i, r] of rows.entries()){
    const r2 = zero(positions[i]);
    assert.ok(Math.abs(r2.pl - r.pl) < 1e-6, `${positions[i].name}: P/L зависит от НКД!`);
    assert.ok(Math.abs(r2.plp - r.plp) < 1e-6, `${positions[i].name}: P/L% зависит от НКД!`);
    checks += 2;
  }
}

// Конкретный случай, который ломался: ОФЗ 26248.
const ofz = rows[3];
assert.ok(Math.abs(ofz.nkd - 118.1332) < 0.01, 'ОФЗ 26248: НКД');
assert.ok(Math.abs(ofz.pl - 4.64) < 0.01, 'ОФЗ 26248: P/L');
assert.ok(Math.abs(ofz.plp - 0.30) < 0.01, 'ОФЗ 26248: P/L%');
assert.ok(Math.abs(ofz.pl - (ofz.value - ofz.cost)) > 100,
          'ОФЗ 26248: НКД снова попал в P/L');
checks += 4;

// Себестоимость покупки тоже не должна включать НКД.
const tradeCtx = {
  state: { report:{ positions:[], trades:[{
    side:'Покупка', code:'BOND', qty:1, amount:997.9, 'nkд':3.1,
    fee_broker:0.6, fee_exchange:0.09, settle:'26.11.2026', time:'10:33:43'
  }] } },
  reportPositions: () => [],
  priceRub: (s, p) => p,
  d2i: d => d,
  refOf: () => null,
  secidOf: r => r ? r.code : null,
};
vm.createContext(tradeCtx);
vm.runInContext(sourceOf('costBasis'), tradeCtx);
const bought = tradeCtx.costBasis().BOND;
assert.ok(Math.abs(bought.cost - 998.59) < 1e-6, 'НКД 3,1 ₽ попал в себестоимость покупки');
checks++;

// Защита от возврата ручного ввода цены: себестоимость приходит с сервера.
const adapter = readFileSync(new URL('../supabase-adapter.js', import.meta.url), 'utf8');
assert.ok(!html.includes('manualCost'), 'Ручная цена покупки снова появилась в интерфейсе');
assert.ok(adapter.includes('state.serverCostBasis'), 'Серверная себестоимость не подключается');
assert.ok(adapter.includes('qty * avg'), 'Серверная себестоимость читается неверно');
checks += 3;

console.log(`OK: ${positions.length} эмитентов, ${checks} проверок. P/L считается по чистой цене.`);
