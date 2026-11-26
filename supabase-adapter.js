/* Мост между исходным портфель.html и Supabase.
   Локальный режим (встроенный отчёт + MOEX) работает без входа. */
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

  function statusSafe(msg, bad) {
    try { setStatus(msg, !!bad); } catch (e) { console.log(msg); }
  }

  function applyRemote(uid) {
    return Promise.all([
      sb.from('app_settings').select('*').eq('user_id', uid).maybeSingle(),
      sb.from('goals').select('*').eq('user_id', uid).order('position', { ascending: true }),
      sb.from('quotes').select('*').eq('user_id', uid),
      sb.from('reports').select('payload').eq('user_id', uid)
        .order('imported_at', { ascending: false }).limit(1).maybeSingle()
    ]).then(function (res) {
      var settings = res[0].data, goals = res[1].data,
          quotes = res[2].data, report = res[3].data;

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
            secid: g.secid,
            qty: Number(g.qty),
            deadline: g.deadline || null,
            kind: g.kind || 'single',
            keepActive: !!g.keep_active
          };
        });
      }
      if (quotes && quotes.length) {
        var map = {};
        quotes.forEach(function (r) {
          var secid = r.secid || r.ticker;
          if (!secid) return;
          var price = Number(r.price) || 0;
          var prev = r.change_pct != null && isFinite(Number(r.change_pct))
            ? price / (1 + Number(r.change_pct) / 100) : price;
          map[secid] = {
            LAST: price,
            PREVPRICE: prev,
            COUPONVALUE: Number(r.accrued) || 0,
            SHORTNAME: r.ticker || secid
          };
        });
        Object.keys(map).forEach(function (k) { state.quotes[k] = map[k]; });
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
      if ($('#btnUser')) $('#btnUser').textContent = String(session.user.email).split('@')[0];
      if ($('#authModal')) $('#authModal').hidden = true;
      return applyRemote(session.user.id);
    });
  }

  checkAuth = function () {
    return sb.auth.getSession().then(function (out) {
      var user = out.data && out.data.session && out.data.session.user;
      if (user) {
        currentAccount = user;
        if ($('#btnUser')) $('#btnUser').textContent = String(user.email).split('@')[0];
        if ($('#authModal')) $('#authModal').hidden = true;
        return true;
      }
      currentAccount = null;
      if ($('#authModal')) $('#authModal').hidden = false;
      return false;
    });
  };

  loadServerState = function () {
    if (!currentAccount) return Promise.resolve(false);
    return applyRemote(currentAccount.id);
  };

  loadServerReport = function () { return loadServerState(); };

  submitAuth = function () {
    var email = $('#authEmail').value.trim();
    var password = $('#authPassword').value;
    if (!email || !password) return Promise.resolve();
    var register = authMode === 'register';
    var req = register
      ? sb.auth.signUp({ email: email, password: password })
      : sb.auth.signInWithPassword({ email: email, password: password });
    return req.then(function (out) {
      if (out.error) throw out.error;
      if (register && !out.data.session) {
        $('#authError').textContent = 'Проверьте почту и подтвердите регистрацию, затем войдите.';
        return;
      }
      currentAccount = out.data.user;
      $('#authModal').hidden = true;
      resetLocalState();
      return applyRemote(currentAccount.id).then(function () {
        renderAll();
        return refreshMarket();
      }).then(function () {
        statusSafe('Вы вошли как ' + email);
      });
    }).catch(function (err) {
      $('#authError').textContent = err.message;
    });
  };

  logoutAccount = function () {
    return sb.auth.signOut().then(function () {
      currentAccount = null;
      if ($('#btnUser')) $('#btnUser').textContent = 'Войти';
      resetLocalState();
      renderAll();
      showAuth();
    });
  };

  scheduleServerSave = function () {
    if (!currentAccount) return;
    clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(function () {
      var uid = currentAccount.id;
      sb.from('app_settings').upsert({
        user_id: uid,
        monthly: state.settings.monthly,
        'yield': state.settings.yield,
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

  /* Кнопка синхронизации: старый обработчик ищет локальный FastAPI — заменяем. */
  var oldSync = $('#btnSync');
  if (oldSync) {
    var sync = oldSync.cloneNode(true);
    oldSync.replaceWith(sync);
    sync.title = 'Перечитать данные из Supabase';
    sync.addEventListener('click', function () {
      statusSafe('Обновление данных…');
      loadRemote().then(function (ok) {
        renderAll();
        return refreshMarket().then(function () {
          statusSafe(ok ? 'Данные из Supabase обновлены' : 'Войдите, чтобы синхронизировать', !ok);
        });
      });
    });
  }

  /* Вход: если уже есть сессия — сразу подтягиваем данные. */
  sb.auth.getSession().then(function (out) {
    if (!out.data || !out.data.session) return;
    loadRemote().then(function (ok) {
      if (!ok) return;
      renderAll();
      refreshMarket().then(function () { statusSafe('Данные из Supabase загружены'); });
    });
  });
})();
