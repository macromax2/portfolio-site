/* Мост между исходным портфель.html и Supabase.
   Без входа работает локальный режим: встроенный отчёт + живые котировки MOEX. */
(function () {
  'use strict';
  if (!window.supabase || !window.supabase.createClient) {
    console.warn('Supabase library not loaded');
    return;
  }

  var SB_URL = 'https://rphzrjzusirtkpbejltz.supabase.co';
  var SB_KEY = 'sb_publishable_OohtluLbJfAPDSzPcvhv5g_e_qQOO8q';
  var sb = window.supabase.createClient(SB_URL, SB_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  var $ = function (s) { return document.querySelector(s); };

  /* Настоящая себестоимость приходит с сервера: она накапливается из всех
     брокерских отчётов (первое появление + докупки - продажи). Пользователь
     ничего не вводит вручную. */
  var originalCostBasis = (typeof costBasis === 'function') ? costBasis : null;
  costBasis = function () {
    var map = originalCostBasis ? originalCostBasis() : {};
    var remote = state.serverCostBasis;
    if (remote) {
      Object.keys(remote).forEach(function (k) {
        var r = remote[k];
        map[k] = {
          qty: r.qty, cost: r.cost,
          realized: (map[k] && map[k].realized) || 0,
          name: r.name || (map[k] && map[k].name) || k
        };
      });
    }
    return map;
  };

  function statusSafe(msg, bad) {
    try { setStatus(msg, !!bad); } catch (e) { console.log(msg); }
  }
  function take(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var c = el.cloneNode(true);
    el.parentNode.replaceChild(c, el);
    return c;
  }

  function applyRemote(uid) {
    return Promise.all([
      sb.from('app_settings').select('*').eq('user_id', uid).maybeSingle(),
      sb.from('goals').select('*').eq('user_id', uid).order('position', { ascending: true }),
      sb.from('quotes').select('*').eq('user_id', uid),
      sb.from('positions').select('*').eq('user_id', uid),
      // Берём последний по дате отчёт, а не последний загруженный: после
      // backfill старые письма импортируются позже нового и иначе дашборд
      // показывает устаревший состав портфеля.
      sb.from('reports').select('payload').eq('user_id', uid)
        .order('period_to', { ascending: false })
        .order('report_created', { ascending: false })
        .limit(1).maybeSingle(),
      // Берём последние 500 сделок, а не первые: через годы журнал вырос бы,
      // и старый лимит показывал бы самые ранние трейды.
      sb.from('transactions').select('isin,ticker,operation_type,date,count,price,amount')
        .eq('user_id', uid).order('date', { ascending: false }).limit(500)
    ]).then(function (res) {
      var settings = res[0].data, goals = res[1].data,
          quotes = res[2].data, positions = res[3].data, report = res[4].data,
          trades = res[5].data;
      // Журнал сделок нужен карточке бумаги: покупка/продажа фиксируется
      // как отдельное событие, даже если позиция закрылась и открылась заново.
      state.serverTrades = (trades || []).filter(function (t) {
        return t.operation_type === 'buy' || t.operation_type === 'sell';
      }).reverse();

      state.serverCostBasis = null;
      var basis = {};
      (positions || []).forEach(function (r) {
        var k = r.ticker || r.isin;
        if (!k) return;
        var qty = Number(r.count) || 0;
        var avg = Number(r.avg_price) || 0;   // ₽ за 1 шт, НКД исключён
        basis[k] = { qty: qty, cost: qty * avg, avg: avg, name: r.name || k };
      });
      state.serverCostBasis = basis;

      if (report && report.payload && report.payload.period) {
        state.report = normalizeReport(report.payload);
        state.history = {}; state.imoex = {}; state.twr = null;
        state.imoexTwr = null; state.kindTwr = {}; state.idxFilter = null;
      }
      if (settings) {
        state.settings = {
          yield: Number(settings['yield']) || 0,
          monthly: Number(settings.monthly) || 0,
          plan: Number(settings.plan) || 1,
          theme: settings.theme || 'auto',
          couponGoal: settings.coupon_goal || ''
        };
        state.couponGoalSecid = settings.coupon_goal || '';
        if (settings.rebalance_targets) state.rebalanceTargets = settings.rebalance_targets;
      }
      if (goals && goals.length) {
        state.goals = goals.map(function (g) {
          return {
            secid: g.secid, qty: Number(g.qty), deadline: g.deadline || null,
            kind: g.kind || 'single', keepActive: !!g.keep_active
          };
        });
      }
      if (quotes && quotes.length) {
        quotes.forEach(function (r) {
          var secid = r.secid || r.ticker;
          if (!secid) return;
          var price = Number(r.price) || 0;
          var prev = r.change_pct != null && isFinite(Number(r.change_pct))
            ? price / (1 + Number(r.change_pct) / 100) : price;
          state.quotes[secid] = {
            LAST: price,
            PREVPRICE: prev,
            COUPONVALUE: Number(r.accrued) || 0,
            SHORTNAME: r.ticker || secid
          };
        });
      }
      return true;
    }).catch(function (err) {
      console.warn('Supabase load error', err);
      statusSafe('Ошибка загрузки из Supabase: ' + err.message, true);
      return false;
    });
  }

  function loadRemote() {
    return sb.auth.getSession().then(function (out) {
      var session = out.data && out.data.session;
      if (!session) return false;
      currentAccount = session.user;
      var btnUser = $('#btnUser');
      if (btnUser) btnUser.textContent = String(session.user.email).split('@')[0];
      if ($('#authModal')) $('#authModal').hidden = true;
      return applyRemote(session.user.id);
    });
  }

  /* Глобальные функции оригинала — переопределяем безопасно. */
  loadServerState = function () {
    return currentAccount ? applyRemote(currentAccount.id) : Promise.resolve(false);
  };

  scheduleServerSave = function () {
    if (!currentAccount) return;
    clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(function () {
      var uid = currentAccount.id;
      sb.from('app_settings').upsert({
        user_id: uid,
        'yield': state.settings.yield,
        monthly: state.settings.monthly,
        plan: state.settings.plan,
        theme: state.settings.theme,
        coupon_goal: state.couponGoalSecid || '',
        rebalance_targets: state.rebalanceTargets,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' }).then(function (r) {
        if (r.error) console.warn('settings save', r.error);
      });
      var rows = state.goals.map(function (g, i) {
        return {
          user_id: uid, secid: g.secid, qty: Number(g.qty),
          deadline: g.deadline || null, kind: g.kind || 'single',
          keep_active: !!g.keepActive, position: i
        };
      });
      if (rows.length) {
        sb.from('goals').upsert(rows, { onConflict: 'user_id,secid' }).then(function (r) {
          if (r.error) console.warn('goals save', r.error);
        });
      }
    }, 800);
  };

  /* Локальные функции входа недоступны — меняем сами элементы,
     чтобы сбросить навешанные на них старые обработчики. */
  var mode = 'login';
  var authForm = take('authForm');
  var authToggle = take('authToggle');
  var btnUser = take('btnUser');
  var btnSync = take('btnSync');

  function paintMode() {
    var reg = mode === 'register';
    if ($('#authTitle')) $('#authTitle').textContent = reg ? 'Регистрация' : 'Вход в «Мой портфель»';
    if ($('#authSubmit')) $('#authSubmit').textContent = reg ? 'Создать аккаунт' : 'Войти';
    if ($('#authToggle')) $('#authToggle').textContent = reg ? 'Уже есть аккаунт' : 'Регистрация';
    if ($('#authHint')) $('#authHint').textContent = reg
      ? 'После регистрации подтвердите почту и войдите.'
      : 'Данные портфеля хранятся в вашем аккаунте Supabase.';
    if ($('#authPassword')) $('#authPassword').autocomplete = reg ? 'new-password' : 'current-password';
    if ($('#authError')) $('#authError').textContent = '';
  }

  function showAuth() {
    if ($('#authModal')) { $('#authModal').hidden = false; $('#authEmail').focus(); }
  }

  function doAuth() {
    var email = $('#authEmail').value.trim();
    var password = $('#authPassword').value;
    if (!email || !password) return;
    var req = mode === 'register'
      ? sb.auth.signUp({ email: email, password: password })
      : sb.auth.signInWithPassword({ email: email, password: password });
    req.then(function (out) {
      if (out.error) throw out.error;
      if (mode === 'register' && !out.data.session) {
        $('#authError').textContent = 'Проверьте почту и подтвердите регистрацию, затем войдите.';
        return;
      }
      currentAccount = out.data.user;
      if ($('#authModal')) $('#authModal').hidden = true;
      if (btnUser) btnUser.textContent = String(email).split('@')[0];
      applyRemote(currentAccount.id).then(function () {
        renderAll();
        return refreshMarket();
      }).then(function () { statusSafe('Вы вошли как ' + email); });
    }).catch(function (err) {
      if ($('#authError')) $('#authError').textContent = err.message;
    });
  }

  if (authForm) authForm.addEventListener('submit', function (e) { e.preventDefault(); doAuth(); });
  if (authToggle) authToggle.addEventListener('click', function () {
    mode = mode === 'login' ? 'register' : 'login'; paintMode();
  });
  if (btnUser) btnUser.addEventListener('click', function () {
    if (!currentAccount) { showAuth(); return; }
    sb.auth.signOut().then(function () {
      currentAccount = null;
      state.serverCostBasis = null;
      btnUser.textContent = 'Войти';
      statusSafe('Вы вышли из аккаунта');
      showAuth();
    });
  });
  if (btnSync) {
    btnSync.title = 'Перечитать данные из Supabase';
    btnSync.addEventListener('click', function () {
      statusSafe('Обновление данных…');
      loadRemote().then(function (ok) {
        renderAll();
        return refreshMarket().then(function () {
          statusSafe(ok ? 'Данные из Supabase обновлены' : 'Войдите, чтобы синхронизировать', !ok);
        });
      });
    });
  }

  /* Если сессия уже сохранена — сразу подтягиваем данные. */
  sb.auth.getSession().then(function (out) {
    if (!out.data || !out.data.session) return;
    loadRemote().then(function (ok) {
      if (!ok) return;
      renderAll();
      refreshMarket().then(function () { statusSafe('Данные из Supabase загружены'); });
    });
  });
})();
