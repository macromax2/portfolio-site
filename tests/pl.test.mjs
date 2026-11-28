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
    state: { quotes: Object.fromEntries(Object.keys(prices).map(k => [k, { NEXTCOUPON: '2027-01-01', COUPONVALUE: 1 }])) },
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
assert.ok(html.includes('Журнал сделок из брокерских отчётов'),
          'В карточке бумаги нет журнала сделок');
assert.ok(adapter.includes("sb.from('transactions')") &&
          adapter.includes('state.serverTrades'),
          'Адаптер не загружает журнал сделок с сервера');
assert.ok(adapter.includes("order('date', { ascending: false })") &&
          adapter.includes('}).reverse()'),
          'Журнал сделок обрежется до самых старых записей');
assert.ok(adapter.includes('mergeReports_') && adapter.includes('state.inceptionQty'),
          'Адаптер не собирает историю всех отчётов с начала портфеля');
assert.ok(adapter.includes(".order('period_from', { ascending: true })") &&
          !adapter.includes(".limit(1).maybeSingle()"),
          'Адаптер берёт только последний отчёт');
assert.ok(html.includes('state.inceptionQty') &&
          html.includes('limit=5000') &&
          html.includes('IMOEX.json?iss.meta=off&from='),
          'TWR/IMOEX считаются не с начала истории');
assert.ok(html.includes('cashTradeDates') && html.includes('cashFeeDates'),
          'Недостающие денежные проводки по сделкам не добавляются');
checks += 5;
assert.ok(html.includes('NF4.format(d.avg)') && !html.includes('d.avg/10') &&
          !html.includes('NF.format(avgShown)'),
          'Цена покупки облигации не показывается в ₽ за штуку');
assert.ok(html.includes('Цена покупки, ₽'),
          'В заголовке колонки не указаны рубли');
assert.ok(html.includes('НКД</th>'), 'В таблице нет отдельной колонки НКД');
assert.ok(html.includes("money(d.nkd)") && !html.includes('в т.ч. НКД'),
          'НКД снова добавляется к стоимости в таблице');
assert.ok(html.includes('total += m.clean') && html.includes('accruedTotal'),
          'Общая стоимость включает НКД');
checks += 9;
assert.ok(html.includes('paidPaymentItems') && html.includes('Уже выплачено в этом месяце') &&
          html.includes('d.slice(0,7)!==month'),
          'Выплаченные купоны не ограничены текущим месяцем');
assert.ok(html.includes('monthlyPaymentPlan') && html.includes('Ожидаем каждый месяц'),
          'Нет расчёта ожидаемой суммы каждый месяц');
assert.ok(html.includes('COUPONPERIOD') && html.includes('365/q.COUPONPERIOD/12'),
          'Месячный доход не учитывает частоту купонов');
assert.ok(html.includes('id="payRepeat"') && html.includes('repeatMonthly'),
          'Нет ежемесячного повтора ручной выплаты');
assert.ok(html.includes('String(a.date).localeCompare(String(b.date))'),
          'Выплаченные купоны идут не с начала портфеля');
assert.ok(html.includes('(d2i(a.date)||"").localeCompare(d2i(b.date)||"")'),
          'Журнал сделок идёт не с начала портфеля');
checks += 6;
assert.ok(html.includes('async function ensureBondCoupons') &&
          html.includes('await ensureBondCoupons(quotes, secids)'),
          'Нет догрузки купонных полей, НКД истории зависит от ответа ISS');
assert.ok(html.includes('/engines/stock/markets/bonds/securities/') &&
          html.includes('COUPONVALUE,NEXTCOUPON,COUPONPERIOD,ACCRUEDINT') &&
          html.includes('cacheQuote(sid, quotes[sid])'),
          'Догрузка купонов не обновляет кэш котировок');
checks += 2;
assert.ok(html.includes('Сводка за месяц') && html.includes('Получено <b>') &&
          html.includes('Ожидается <b>') && html.includes('Итого '),
          'Нет сводки «получено / ожидается / итого» за месяц');
assert.ok(html.includes('const expectedMonth = now.reduce') &&
          html.includes('slice(0,7)===month'),
          'Ожидаемые выплаты в сводке не ограничены текущим месяцем');
checks += 2;

console.log(`OK: ${positions.length} эмитентов, ${checks} проверок. P/L считается по чистой цене.`);
