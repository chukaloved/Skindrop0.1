/* SkinDrop — клиент мини-приложения Telegram */
(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  // Адрес сервера: из config.js, а если игра лежит на GitHub Pages — из server.json рядом (см. init)
  let API = (window.SKINDROP_API || "").replace(/\/$/, "");
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");

  const RARITY = {
    milspec: { name: "Армейское", color: "#4b69ff" },
    restricted: { name: "Запрещённое", color: "#8847ff" },
    classified: { name: "Засекреченное", color: "#d32ce6" },
    covert: { name: "Тайное", color: "#eb4b4b" },
    gold: { name: "★ Редкий особый предмет", color: "#e4ae39" },
  };
  const RANK = ["milspec", "restricted", "classified", "covert", "gold"];
  const WEAR = { FN: "Прямо с завода", MW: "Немного поношенное", FT: "После полевых испытаний", WW: "Поношенное", BS: "Закалённое в боях" };

  const state = { user: null, cfg: null, count: 1, spinning: false, skip: null, inSeq: false, skipAll: false, sort: "new", topCat: "value" };

  // ── Telegram ───────────────────────────────────────────────
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0a0a0c"); tg.setBackgroundColor("#0a0a0c"); } catch (e) {}
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
  }
  const haptic = {
    tick() { try { tg && tg.HapticFeedback.selectionChanged(); } catch (e) {} },
    hit(style = "medium") { try { tg && tg.HapticFeedback.impactOccurred(style); } catch (e) {} },
    ok() { try { tg && tg.HapticFeedback.notificationOccurred("success"); } catch (e) {} },
    err() { try { tg && tg.HapticFeedback.notificationOccurred("error"); } catch (e) {} },
  };

  // ── Звуки (Web Audio, без файлов; по умолчанию выключены) ──
  const sound = {
    on: false, ctx: null, lastTick: 0,
    ensure() {
      if (!this.on) return null;
      if (!this.ctx) {
        try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, { type = "triangle", vol = 0.08, at = 0 } = {}) {
      const ctx = this.ensure();
      if (!ctx) return;
      const t = ctx.currentTime + at;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    // щелчок ленты на каждой карточке
    tick() {
      const now = performance.now();
      if (now - this.lastTick < 28) return;
      this.lastTick = now;
      this.tone(2100 + Math.random() * 300, 0.03, { type: "square", vol: 0.025 });
    },
    // звук выпадения: чем реже предмет, тем длиннее и выше аккорд
    win(rarity) {
      const chords = {
        milspec: [523],
        restricted: [523, 659],
        classified: [523, 659, 784],
        covert: [523, 659, 784, 1047],
        gold: [523, 659, 784, 1047, 1319, 1568],
      };
      (chords[rarity] || chords.milspec).forEach((f, i) =>
        this.tone(f, rarity === "gold" ? 0.6 : 0.35, { vol: 0.07, at: i * (rarity === "gold" ? 0.09 : 0.07) }));
    },
    coins() { [1319, 1760].forEach((f, i) => this.tone(f, 0.12, { type: "sine", vol: 0.06, at: i * 0.06 })); },
  };

  // ── API ────────────────────────────────────────────────────
  function devUser() {
    const p = new URLSearchParams(location.search).get("dev");
    if (p) { try { localStorage.setItem("devUser", p); } catch (e) {} return p; }
    try { return localStorage.getItem("devUser") || "1"; } catch (e) { return "1"; }
  }

  // Номер устройства: постоянный для этого телефона/ПК, чтобы повторное открытие не блокировало само себя
  const SID = (() => {
    const make = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    for (const store of [() => localStorage, () => sessionStorage]) {
      try {
        const s = store();
        let v = s.getItem("deviceId");
        if (!v) { v = make(); s.setItem("deviceId", v); }
        return v;
      } catch (e) {}
    }
    return make();
  })();

  async function api(path, body) {
    const headers = { "Content-Type": "application/json", "X-Session": SID };
    if (tg && tg.initData) headers.Authorization = "tma " + tg.initData;
    else headers["X-Dev-User"] = devUser();
    let res;
    try {
      res = await fetch(API + path, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // сервер выключен или туннель упал: запрос не дошёл вообще
      serverDown();
      throw new Error("Нет связи с сервером");
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.status === 503 && data && data.detail && data.detail.code === "maintenance") {
      showMaintenance(data.detail.message);
      throw new Error(data.detail.message);
    }
    if (res.status === 409 && data && data.detail && data.detail.code === "session_conflict") {
      lockSession(data.detail.message);
      throw new Error(data.detail.message);
    }
    if (!res.ok) {
      const d = data && data.detail;
      throw new Error((typeof d === "string" ? d : d && d.message) || "Ошибка сервера (" + res.status + ")");
    }
    return data;
  }

  // ── UI-хелперы ─────────────────────────────────────────────
  let toastTimer;
  function toast(text, isErr) {
    const t = $("#toast");
    t.textContent = text;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
    isErr ? haptic.err() : null;
  }

  function openModal(html) {
    $("#modalSheet").innerHTML = html;
    $("#modal").hidden = false;
  }
  function closeModal() { $("#modal").hidden = true; }
  $("#modal").addEventListener("click", (e) => { if (e.target.hasAttribute("data-close")) closeModal(); });

  const coinSvg = '<svg class="ico coin"><use href="#i-coin"/></svg>';
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function imgUrl(src) {
    if (!src) return null;
    if (/^https?:/.test(src)) return src;
    // локальный путь img/skins/… лежит на сервере, а не рядом со страницей на GitHub Pages
    return API ? API + "/" + src.replace(/^\//, "") : src;
  }

  function splitName(item) {
    const parts = String(item.name || "").split(" | ");
    return { weapon: parts[0] || item.weapon || "", pattern: parts[1] || item.pattern || "" };
  }

  function cardHTML(item, extra = "", lazy = false) {
    const { weapon, pattern } = splitName(item);
    const src = imgUrl(item.image);
    const img = src
      ? `<img src="${esc(src)}" alt=""${lazy ? ' loading="lazy"' : ""} decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card__ph',textContent:${esc(JSON.stringify(weapon))}}))">`
      : `<div class="card__ph">${esc(weapon)}</div>`;
    const badges = item.wear || item.stattrak
      ? `<div class="card__badges">${item.wear ? `<span class="card__wear">${esc(item.wear)}</span>` : ""}${item.stattrak ? '<span class="card__stt">ST™</span>' : ""}</div>`
      : "";
    const price = item.price != null ? `<div class="card__p">${coinSvg}${fmt(item.price)}</div>` : "";
    return `<div class="card" data-r="${esc(item.rarity)}">${badges}
      <div class="card__img">${img}</div>
      <div class="card__txt"><div class="card__w">${esc(weapon)}</div>
      <div class="card__n">${esc(pattern || weapon)}</div>${price}${extra}</div></div>`;
  }

  // ── Состояние игрока ───────────────────────────────────────
  function setUser(u) {
    if (!u) return;
    state.user = Object.assign(state.user || {}, u);
    u = state.user;
    animateNumber($("#coins"), u.coins);
    $("#spins").textContent = fmt(u.spins);
    $("#lvl").textContent = u.level;
    $("#xpText").textContent = `${u.xp} из ${u.xp_needed} XP`;
    $("#xpBar").style.width = Math.min(100, (u.xp / u.xp_needed) * 100) + "%";
    const dailyReady = !u.daily_available_at || new Date(u.daily_available_at) <= new Date();
    $("#dailyBtn").hidden = !dailyReady;
    $("#adminEntry").hidden = !u.is_admin;
    if (u.is_admin && u.maintenance != null) renderMaintAdmin(!!u.maintenance);
    if (u.achievements_ready != null) {
      const n = u.achievements_ready;
      $("#achBadge").hidden = !n;
      $("#achBadge").textContent = n;
      $('.tab[data-tab="profile"]').classList.toggle("has-dot", n > 0);
    }
    if (u.regen) {
      regen.deadline = u.regen.seconds_left == null ? null : Date.now() + u.regen.seconds_left * 1000;
      regen.interval = u.regen.interval;
      regen.max = u.regen.max;
      renderRegen();
    }
    updateSpinButton();
  }

  // Плавная анимация числа (монеты): ~0.7 с с замедлением в конце
  const numAnim = new WeakMap();
  function animateNumber(el, to) {
    const prev = numAnim.get(el);
    const from = prev ? prev.current : Number(String(el.textContent).replace(/\D/g, "")) || 0;
    if (prev) cancelAnimationFrame(prev.raf);
    if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = fmt(to);
      numAnim.set(el, { current: to });
      return;
    }
    const dur = 700, t0 = performance.now();
    const st = { current: from, raf: 0 };
    numAnim.set(el, st);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      st.current = Math.round(from + (to - from) * e);
      el.textContent = fmt(st.current);
      if (k < 1) st.raf = requestAnimationFrame(step);
      else el.closest(".chip-stat")?.classList.remove("bump");
    };
    if (to > from) { const chip = el.closest(".chip-stat"); chip?.classList.remove("bump"); void chip?.offsetWidth; chip?.classList.add("bump"); }
    st.raf = requestAnimationFrame(step);
  }

  // ── Восстановление круток ──────────────────────────────────
  const regen = { deadline: null, interval: 60, max: 30, refreshing: false };
  const RING = 2 * Math.PI * 17;
  function renderRegen() {
    const chip = $(".chip-stat--spins");
    const ring = $("#regenRing");
    if (regen.deadline == null) {
      chip.classList.add("full");
      ring.style.strokeDashoffset = 0;
      $("#regenText").textContent = "запас полный";
      return;
    }
    chip.classList.remove("full");
    const left = Math.max(0, Math.ceil((regen.deadline - Date.now()) / 1000));
    ring.style.strokeDasharray = RING;
    ring.style.strokeDashoffset = RING * (left / regen.interval);
    $("#regenText").textContent = `+1 через ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0 && !regen.refreshing && !state.spinning) {
      regen.refreshing = true;
      api("/api/me").then(setUser).catch(() => {}).finally(() => (regen.refreshing = false));
    }
  }
  setInterval(renderRegen, 1000);

  function updateSpinButton() {
    const u = state.user;
    const btn = $("#spinBtn");
    const enough = u && u.spins >= state.count;
    const skippable = state.spinning && !state.skipAll && (!!state.skip || state.inSeq);
    $("#spinCost").innerHTML = skippable
      ? '<svg class="ico"><use href="#i-skip"/></svg>'
      : `<svg class="ico"><use href="#i-spin"/></svg>${state.count}`;
    $("#spinLabel").textContent = skippable ? "Пропустить"
      : state.spinning ? "Открываем…"
      : !enough ? "Купить крутки"
      : state.count === 1 ? "Открыть кейс" : `Открыть ×${state.count}`;
    btn.classList.toggle("busy", state.spinning && !skippable);
    btn.classList.toggle("skip", skippable);
    btn.classList.toggle("spin--empty", !enough && !state.spinning);
    btn.disabled = state.spinning && !skippable;
  }

  // ── Навигация ──────────────────────────────────────────────
  function go(tab) {
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + tab));
    const navTab = tab === "admin" || tab === "achievements" ? "profile" : tab === "tradeup" ? "inventory" : tab;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === navTab));
    window.scrollTo(0, 0);
    if (tab === "inventory") loadInventory();
    if (tab === "top") loadTop();
    if (tab === "shop") renderShop();
    if (tab === "profile") loadProfile();
    if (tab === "game") loadFeed();
    if (tab === "admin") { loadAdmin(); loadPromos(); }
    if (tab === "achievements") loadAchievements();
    if (tab === "tradeup") loadTradeup();
    haptic.tick();
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => go(t.dataset.tab)));
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));

  // ── Рулетка ────────────────────────────────────────────────
  const WIN_INDEX = 48;
  const STRIP_LEN = 58;

  // Пул скинов для ленты: грузим один раз и заранее скачиваем картинки,
  // чтобы при прокрутке лента не мигала пустыми карточками.
  const pool = { skins: [], spinsSinceRefresh: 0 };
  const imgCache = new Map();

  function preload(src, timeout = 2500) {
    if (!src) return Promise.resolve();
    if (!imgCache.has(src)) {
      imgCache.set(src, new Promise((resolve) => {
        const im = new Image();
        im.decoding = "async";
        im.onload = im.onerror = () => resolve();
        im.src = src;
      }));
    }
    // не ждём дольше timeout — медленная картинка не должна тормозить крутку
    return Promise.race([imgCache.get(src), new Promise((r) => setTimeout(r, timeout))]);
  }

  async function refreshPool(onImage) {
    try {
      const skins = await api("/api/strip?n=90");
      pool.skins = skins;
      pool.spinsSinceRefresh = 0;
      return skins.map((sk) => { const p = preload(imgUrl(sk.image), 5000); if (onImage) onImage(p); return p; });
    } catch (e) { return []; }
  }

  async function buildStrip() {
    if (pool.skins.length < 20) await refreshPool();
    if (pool.skins.length < 20) return api("/api/strip?n=" + STRIP_LEN);
    // время от времени обновляем пул в фоне, чтобы лента не приедалась
    if (++pool.spinsSinceRefresh >= 15) refreshPool();
    return Array.from({ length: STRIP_LEN }, () => pool.skins[Math.floor(Math.random() * pool.skins.length)]);
  }
  const track = $("#track");
  const roulette = $("#roulette");

  function cardStep() {
    const cs = getComputedStyle(document.documentElement);
    return parseFloat(cs.getPropertyValue("--card-w")) + parseFloat(cs.getPropertyValue("--card-gap"));
  }

  async function fillIdleStrip(onImage) {
    try {
      const skins = await api("/api/strip?n=14");
      await Promise.all(skins.map((sk) => { const p = preload(imgUrl(sk.image), 5000); if (onImage) onImage(p); return p; }));
      track.style.transition = "none";
      track.innerHTML = skins.map((s) => cardHTML(s)).join("");
      const step = cardStep();
      const offset = roulette.clientWidth / 2 - (step - 8) / 2 - 6 * step;
      track.style.transform = `translateX(${offset}px)`;
    } catch (e) {
      track.innerHTML = `<div class="feed__empty" style="padding:50px 20px">${esc(e.message)}</div>`;
    }
  }

  // Прокрутка ленты. Пока она идёт, state.skip позволяет сразу перейти к результату.
  function animateTo(targetX, duration) {
    return new Promise((resolve) => {
      const step = cardStep();
      let lastIdx = null, raf = 0, timer = 0, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        state.skip = null;
        resolve();
      };
      const watch = () => {
        const m = new DOMMatrixReadOnly(getComputedStyle(track).transform);
        const idx = Math.floor((roulette.clientWidth / 2 - m.m41) / step);
        if (idx !== lastIdx) {
          if (lastIdx !== null) { haptic.tick(); sound.tick(); }
          lastIdx = idx;
        }
        raf = requestAnimationFrame(watch);
      };
      state.skip = () => {
        track.style.transition = "none";
        track.style.transform = `translateX(${targetX}px)`;
        finish();
      };
      updateSpinButton();
      track.style.transition = `transform ${duration}ms cubic-bezier(.12,.72,.18,1)`;
      requestAnimationFrame(() => {
        if (done) return;
        track.style.transform = `translateX(${targetX}px)`;
        raf = requestAnimationFrame(watch);
      });
      timer = setTimeout(finish, duration + 60);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byValue = (a, b) => RANK.indexOf(b.rarity) - RANK.indexOf(a.rarity) || b.price - a.price;

  // Одна прокрутка ленты до предмета item. fast — короткая лента и ~0,75 с.
  async function runReel(item, fast) {
    const win = fast ? 14 : WIN_INDEX;
    let strip = await buildStrip();
    strip = strip.slice(0, fast ? win + 7 : STRIP_LEN);
    strip[win] = item;
    track.style.transition = "none";
    track.innerHTML = strip.map((s) => cardHTML(s)).join("");
    const step = cardStep();
    const cardW = step - 8;
    track.style.transform = `translateX(${roulette.clientWidth / 2 - cardW / 2 - 2 * step}px)`;
    track.getBoundingClientRect(); // reflow
    const jitter = (Math.random() - 0.5) * cardW * (fast ? 0.4 : 0.7);
    const targetX = roulette.clientWidth / 2 - (win * step + cardW / 2) + jitter;
    if (state.skipAll) track.style.transform = `translateX(${targetX}px)`;
    else await animateTo(targetX, fast ? 750 : 5600);
    const winCard = track.children[win];
    if (winCard) winCard.classList.add("win");
  }

  // Ряд значков выпавших скинов под названием в блоке «последний дроп»
  function trayHTML(order, filled) {
    return `<span class="tray">${order.map((d, i) => i < filled
      ? `<i class="tray__slot is-on" style="--rc:${RARITY[d.rarity].color}">${d.image ? `<img src="${esc(imgUrl(d.image))}" alt="">` : ""}</i>`
      : '<i class="tray__slot"></i>').join("")}</span>`;
  }

  async function doSpin() {
    if (state.spinning) return;
    if (!state.user || state.user.spins < state.count) { go("shop"); return; }

    state.spinning = true;
    state.skipAll = false;
    updateSpinButton();
    haptic.hit("light");
    const counter = $("#spinCounter");

    try {
      const result = await api("/api/spin", { count: state.count });
      const drops = result.drops;
      // Самый редкий/дорогой — последним и на медленной прокрутке, остальные в случайном порядке
      const best = drops.slice().sort(byValue)[0];
      const order = drops.filter((d) => d !== best).sort(() => Math.random() - 0.5).concat([best]);
      drops.forEach((d) => preload(imgUrl(d.image)));
      await preload(imgUrl(best.image));
      const multi = order.length > 1;

      state.inSeq = true;
      updateSpinButton();
      for (let i = 0; i < order.length; i++) {
        const last = i === order.length - 1;
        if (multi) { counter.hidden = false; counter.textContent = `${i + 1} / ${order.length}`; }
        await runReel(order[i], multi && !last);
        if (multi) setHero(order[i], trayHTML(order, i + 1));
        if (!last && !state.skipAll) {
          sound.tone(660 + RANK.indexOf(order[i].rarity) * 160, 0.09, { vol: 0.05 });
          haptic.hit(RANK.indexOf(order[i].rarity) >= 2 ? "medium" : "light");
          await sleep(RANK.indexOf(order[i].rarity) >= 2 ? 450 : 160);
        }
      }
      state.inSeq = false;
      counter.hidden = true;

      setHero(best, multi ? trayHTML(order, order.length) : null);
      RANK.indexOf(best.rarity) >= 2 ? haptic.ok() : haptic.hit("heavy");
      sound.win(best.rarity);

      setUser({ ...result.user, achievements_ready: result.achievements_ready });
      if (drops.length === 1) showDrop(drops[0], result.level_up);
      else showMulti(drops, result.level_up);
      if (result.level_up) setTimeout(() => haptic.ok(), 350);
      loadFeed();
    } catch (e) {
      toast(e.message, true);
    } finally {
      state.spinning = false;
      state.inSeq = false;
      state.skipAll = false;
      state.skip = null;
      counter.hidden = true;
      updateSpinButton();
    }
  }

  function setHero(item, metaHTML) {
    const hero = $("#hero");
    const { weapon, pattern } = splitName(item);
    hero.dataset.r = item.rarity;
    $("#heroRarity").textContent = RARITY[item.rarity].name;
    $("#heroName").innerHTML = `${item.stattrak ? '<span class="st">StatTrak™ </span>' : ""}${esc(weapon)}${pattern ? " | " + esc(pattern) : ""}`;
    $("#heroMeta").innerHTML = metaHTML
      || `<span class="hero__price">${coinSvg}${fmt(item.price)}</span><span>${esc(WEAR[item.wear] || item.wear || "")}</span>`;
    hero.classList.remove("pop"); void hero.offsetWidth; hero.classList.add("pop");
  }

  function dropHTML(item) {
    const color = RARITY[item.rarity].color;
    const { weapon, pattern } = splitName(item);
    const src = imgUrl(item.image);
    return `<div class="drop" style="--rc:${color}">
      <div class="drop__glow">${src ? `<img src="${esc(src)}" alt="">` : `<div class="drop__ph">${esc(weapon)}</div>`}</div>
      <div class="drop__rarity">${RARITY[item.rarity].name}</div>
      <div class="drop__name">${item.stattrak ? '<span class="st">StatTrak™ </span>' : ""}${esc(weapon)}${pattern ? " | " + esc(pattern) : ""}</div>
      <div class="drop__meta">${WEAR[item.wear] || item.wear}, float ${Number(item.float).toFixed(4)}</div>
      <div class="drop__price">${coinSvg}${fmt(item.price)}</div>
    </div>`;
  }

  // Блок «Новый уровень» внутри окна дропа: крутки + гарантированные скины
  function levelUpHTML(lu) {
    if (!lu) return "";
    const lv = lu.levels.length > 1 ? `Уровни ${lu.levels[0]}–${lu.level}` : `Уровень ${lu.level}`;
    const items = (lu.items || []).map((it) => cardHTML(it, `<div class="lvlup__tag">за ${it.level} ур.</div>`)).join("");
    return `<div class="lvlup">
      <div class="lvlup__head"><span class="lvlup__badge">${lu.level}</span>
        <span><b>${lv}!</b><small>+${fmt(lu.bonus_spins)} круток${items ? " и гарантированный скин" : ""}</small></span></div>
      ${items ? `<div class="lvlup__items">${items}</div>` : ""}
    </div>`;
  }

  function showDrop(item, lu) {
    if (item.auto_sold) {
      openModal(`${dropHTML(item)}<p class="autosold-note">Продано автоматически: +${coinSvg}${fmt(item.price)}</p>${levelUpHTML(lu)}
        <div class="btns"><button class="btn btn--light" id="mKeep">Понятно</button></div>`);
      $("#mKeep").onclick = closeModal;
      sound.coins();
      return;
    }
    openModal(`${dropHTML(item)}${levelUpHTML(lu)}
      <div class="btns">
        <button class="btn btn--ghost" id="mSell">Продать ${coinSvg}${fmt(item.price)}</button>
        <button class="btn btn--light" id="mKeep">В инвентарь</button>
      </div>`);
    $("#mKeep").onclick = closeModal;
    $("#mSell").onclick = () => sellItem(item.id, true);
  }

  // Мульти-дроп: нажатием на скин отмечаем его на продажу, остальные уходят в инвентарь
  function showMulti(drops, lu) {
    const total = drops.reduce((s, d) => s + d.price, 0);
    const picked = new Set();
    const auto = drops.filter((d) => d.auto_sold);
    const autoSum = auto.reduce((s, d) => s + d.price, 0);
    const rest = drops.filter((d) => !d.auto_sold);
    openModal(`<div class="multi__head"><h2>Дроп ×${drops.length}</h2><b>${coinSvg} ${fmt(total)}</b></div>
      ${auto.length ? `<p class="autosold-note">Автопродажа: ${auto.length} шт. на +${coinSvg}${fmt(autoSum)}</p>` : ""}
      ${rest.length ? '<p class="multi__hint">Нажмите на скины, которые хотите продать</p>' : ""}
      <div class="multi__grid">${drops.map((d, i) => cardHTML(d).replace('class="card"', `class="card${d.auto_sold ? " is-autosold" : ""}" style="animation-delay:${i * 60}ms" data-id="${d.id}"`)).join("")}</div>
      ${levelUpHTML(lu)}
      <div class="btns">
        <button class="btn btn--ghost" id="mSellAll">Продать всё</button>
        <button class="btn btn--light" id="mMain">В инвентарь</button>
      </div>`);
    const main = $("#mMain");
    const refresh = () => {
      const sum = drops.filter((d) => picked.has(d.id)).reduce((s, d) => s + d.price, 0);
      main.innerHTML = picked.size ? `Продать ${coinSvg}${fmt(sum)}` : "В инвентарь";
    };
    $$(".multi__grid .card:not(.is-autosold)").forEach((c) => c.addEventListener("click", () => {
      const id = Number(c.dataset.id);
      picked.has(id) ? picked.delete(id) : picked.add(id);
      c.classList.toggle("picked", picked.has(id));
      haptic.tick();
      refresh();
    }));
    const sellIds = async (ids) => {
      try {
        const r = await api("/api/inventory/sell-ids", { ids });
        setUser(r.user);
        haptic.ok();
        const kept = drops.length - r.sold;
        toast(`Продано ${r.sold} на ${fmt(r.earned)} монет` + (kept > 0 ? `, ${kept} в инвентаре` : ""));
      } catch (e) { toast(e.message, true); }
      closeModal();
    };
    main.onclick = () => (picked.size ? sellIds([...picked]) : closeModal());
    $("#mSellAll").onclick = () => sellIds(rest.map((d) => d.id));
    if (!rest.length) { $("#mSellAll").hidden = true; main.textContent = "Понятно"; }
    if (auto.length) sound.coins();
  }

  async function sellItem(id, fromDrop) {
    try {
      const r = await api(`/api/inventory/${id}/sell`, {});
      setUser(r.user);
      haptic.ok();
      sound.coins();
      toast(`+${fmt(r.earned)} монет`);
      closeModal();
      if (!fromDrop) loadInventory();
    } catch (e) { toast(e.message, true); }
  }

  const onShowcase = (id) => (state.user && state.user.showcase || []).some((x) => x.id === id);

  function showItem(item) {
    const shown = onShowcase(item.id);
    openModal(`${dropHTML(item)}
      <button class="line-btn" id="mShow">${shown ? "Убрать с витрины" : "⭐ На витрину"}</button>
      <div class="btns">
        <button class="btn btn--ghost" data-close-btn>Закрыть</button>
        <button class="btn btn--light" id="mSell">Продать ${coinSvg}${fmt(item.price)}</button>
      </div>`);
    $("[data-close-btn]").onclick = closeModal;
    $("#mSell").onclick = () => sellItem(item.id, false);
    $("#mShow").onclick = () => toggleShowcase(item.id, !shown);
  }

  async function toggleShowcase(id, on) {
    try {
      const r = await api("/api/showcase", { item_id: id, on });
      state.user.showcase = r.showcase;
      haptic.ok();
      toast(on ? "Выставлено на витрину" : "Убрано с витрины");
      closeModal();
      renderMyShowcase();
    } catch (e) { toast(e.message, true); }
  }

  $("#spinBtn").addEventListener("click", () => {
    sound.ensure();
    if (state.spinning && (state.skip || state.inSeq)) {
      state.skipAll = true;
      if (state.skip) state.skip();
      updateSpinButton();
      haptic.hit("light");
      return;
    }
    doSpin();
  });
  $$("#countSeg .seg__b").forEach((b) => b.addEventListener("click", () => {
    if (state.spinning) return;
    state.count = Number(b.dataset.count);
    $$("#countSeg .seg__b").forEach((x) => x.classList.toggle("active", x === b));
    updateSpinButton();
    haptic.tick();
  }));

  $("#dailyBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/daily", {});
      setUser(r.user);
      haptic.ok();
      toast(`+${r.bonus} круток! Возвращайтесь завтра`);
    } catch (e) { toast(e.message, true); }
  });

  // ── Лента редких дропов ────────────────────────────────────
  async function loadFeed() {
    try {
      const items = await api("/api/feed");
      if (!items.length) return;
      $("#feed").innerHTML = items.map((d) => cardHTML(d, `<div class="feed__owner">${esc(d.owner)}</div>`)
        .replace('class="card"', `class="card" data-pid="${d.owner_id}"`)).join("");
    } catch (e) {}
  }

  $("#feed").addEventListener("click", (e) => {
    const c = e.target.closest("[data-pid]");
    if (c) openPlayer(Number(c.dataset.pid));
  });

  // ── Инвентарь ──────────────────────────────────────────────
  let invItems = [];
  async function loadInventory() {
    try {
      const [items, me] = await Promise.all([api("/api/inventory?limit=200&sort=" + state.sort), api("/api/me")]);
      invItems = items;
      setUser(me);
      $("#invCount").textContent = fmt(me.inventory_count);
      $("#invValue").textContent = fmt(me.inventory_value);
      $("#invEmpty").hidden = items.length > 0;
      $("#invGrid").innerHTML = items.map((d) => cardHTML(d, "", true).replace('class="card"', `class="card" data-id="${d.id}"`)).join("");
    } catch (e) { toast(e.message, true); }
  }
  $("#invGrid").addEventListener("click", (e) => {
    const c = e.target.closest(".card");
    if (!c) return;
    const d = invItems.find((x) => String(x.id) === c.dataset.id);
    if (d) showItem(d);
  });
  $$("#sortChips [data-sort]").forEach((c) => c.addEventListener("click", () => {
    state.sort = c.dataset.sort;
    $$("#sortChips [data-sort]").forEach((x) => x.classList.toggle("active", x === c));
    loadInventory();
  }));
  // Быстрая продажа по категориям редкости
  async function openSellMenu() {
    let sum;
    try { sum = await api("/api/inventory/summary"); } catch (e) { toast(e.message, true); return; }
    const chosen = new Set(["milspec"]);
    let keepST = true;
    const rows = RANK.map((r) => `<label class="sellrow${sum[r].count ? "" : " empty"}">
        <input type="checkbox" data-r="${r}" ${chosen.has(r) && sum[r].count ? "checked" : ""} ${sum[r].count ? "" : "disabled"}>
        <span class="sellrow__dot" style="background:${RARITY[r].color}"></span>
        <span class="sellrow__name">${RARITY[r].name}<small>${fmt(sum[r].count)} шт.</small></span>
        <span class="sellrow__v">${coinSvg}${fmt(sum[r].value)}</span>
      </label>`).join("");
    openModal(`<h2 class="sheet-title">Быстрая продажа</h2>
      <p class="sub" style="margin-top:0">Выберите, какие категории продать</p>
      <div class="sellmenu">${rows}</div>
      <label class="check sellmenu__st"><input type="checkbox" id="keepST" checked> Не продавать StatTrak™</label>
      <p class="sellmenu__count" id="sellCount"></p>
      <div class="btns"><button class="btn btn--ghost" data-close-btn>Отмена</button>
      <button class="btn btn--light" id="mConfirm">Продать</button></div>`);
    const btn = $("#mConfirm");
    const calc = () => {
      let n = 0, v = 0;
      chosen.forEach((r) => {
        n += sum[r].count - (keepST ? sum[r].st_count : 0);
        v += sum[r].value - (keepST ? sum[r].st_value : 0);
      });
      btn.disabled = n === 0;
      btn.innerHTML = n ? `Продать ${coinSvg}${fmt(v)}` : "Нечего продавать";
      $("#sellCount").textContent = n ? `Будет продано ${fmt(n)} шт.` : "Выберите хотя бы одну категорию";
    };
    $$(".sellmenu input").forEach((i) => i.addEventListener("change", () => {
      i.checked ? chosen.add(i.dataset.r) : chosen.delete(i.dataset.r);
      calc();
    }));
    $("#keepST").addEventListener("change", (e) => { keepST = e.target.checked; calc(); });
    $("[data-close-btn]").onclick = closeModal;
    btn.onclick = async () => {
      try {
        const r = await api("/api/inventory/sell-many", { rarities: [...chosen], keep_stattrak: keepST });
        setUser(r.user);
        closeModal();
        haptic.ok();
        toast(r.sold ? `Продано ${fmt(r.sold)} шт. на ${fmt(r.earned)} монет` : "Нечего продавать");
        loadInventory();
      } catch (e) { toast(e.message, true); }
    };
    calc();
  }
  $("#sellCheapBtn").addEventListener("click", openSellMenu);

  // ── Достижения ─────────────────────────────────────────────
  const ACH_ICONS = { "Крутки": "i-spin", "Уровни": "i-star", "Дропы": "i-gem", "Особые": "i-spark", "Монеты": "i-coin", "Активность": "i-cal" };
  async function loadAchievements() {
    try {
      const list = await api("/api/achievements");
      const done = list.filter((a) => a.claimed).length;
      $("#achCount").textContent = `${done} из ${list.length}`;
      const groups = [...new Set(list.map((a) => a.group))];
      // сначала готовые к получению, затем в процессе, затем полученные
      const order = (a) => (a.done && !a.claimed ? 0 : a.claimed ? 2 : 1);
      $("#achList").innerHTML = groups.map((g) => `<h3 class="ach-group">${esc(g)}</h3>` +
        list.filter((a) => a.group === g).sort((x, y) => order(x) - order(y)).map((a) => {
          const pct = Math.min(100, (a.value / a.target) * 100);
          const btn = a.claimed
            ? '<span class="ach__state">Получено</span>'
            : a.done
              ? `<button class="ach__claim" data-ach="${a.id}">Забрать +${a.reward}</button>`
              : `<span class="ach__reward"><svg class="ico"><use href="#i-spin"/></svg>${a.reward}</span>`;
          return `<div class="ach${a.claimed ? " is-claimed" : a.done ? " is-ready" : ""}">
            <span class="ach__ico"><svg class="ico"><use href="#${ACH_ICONS[a.group] || "i-star"}"/></svg></span>
            <span class="ach__body"><b>${esc(a.title)}</b><small>${esc(a.desc)}</small>
              ${a.claimed ? "" : `<span class="ach__bar"><i style="width:${pct}%"></i></span><small class="ach__num">${fmt(a.value)} / ${fmt(a.target)}</small>`}
            </span>${btn}</div>`;
        }).join("")).join("");
    } catch (e) { toast(e.message, true); }
  }
  $("#achList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ach]");
    if (!b) return;
    b.disabled = true;
    try {
      const r = await api(`/api/achievements/${b.dataset.ach}/claim`, {});
      setUser({ ...r.user, achievements_ready: r.achievements_ready });
      haptic.ok();
      toast(`+${r.reward} круток за достижение`);
      loadAchievements();
    } catch (e) { b.disabled = false; toast(e.message, true); }
  });

  // ── Топ ────────────────────────────────────────────────────
  function avatarHTML(u) {
    return u.photo_url ? `<img src="${esc(u.photo_url)}" alt="">` : esc((u.first_name || "?").slice(0, 1).toUpperCase());
  }
  const TOP_CATS = {
    value: { sub: "Стоимость всех скинов в инвентаре", me: "Стоимость вашего инвентаря" },
    best: { sub: "Самый дорогой скин, который игрок выбил", me: "Ваш лучший дроп" },
    spins: { sub: "Сколько кейсов открыл игрок", me: "Вы открыли кейсов" },
  };
  const spinSvg = '<svg class="ico"><use href="#i-spin"/></svg>';
  const topValue = (cat, v) => (cat === "spins" ? spinSvg : coinSvg) + fmt(v);

  async function loadTop() {
    const cat = state.topCat;
    $("#topSub").textContent = TOP_CATS[cat].sub;
    try {
      const r = await api("/api/top?cat=" + cat);
      if (r.cat !== state.topCat) return;
      $("#topList").innerHTML = r.top.length ? r.top.map((u, i) => {
        let sub = `Уровень ${u.level}`;
        if (cat === "value") sub += `, ${fmt(u.items)} предм.`;
        if (cat === "best" && u.item) sub = `${u.item.stattrak ? "ST™ " : ""}${esc(u.item.name)}`;
        const thumb = cat === "best" && u.item && u.item.image
          ? `<img class="toprow__item" src="${esc(imgUrl(u.item.image))}" alt="" loading="lazy">` : "";
        return `<li class="toprow" data-pid="${u.id}" ${cat === "best" && u.item ? `style="--rc:${RARITY[u.item.rarity].color}"` : ""}>
          <span class="toprow__n">${i + 1}</span>
          <span class="toprow__a">${avatarHTML(u)}</span>
          <span class="toprow__name"><b>${esc(u.first_name)}</b><small>${sub}</small></span>
          ${thumb}<span class="toprow__v">${topValue(cat, u.value)}</span></li>`;
      }).join("") : '<li class="empty">Пока никого нет</li>';
      $("#myRank").innerHTML = state.user ? `<span class="toprow__n">#${r.my_rank}</span>
        <span class="toprow__name"><b>Вы</b><small>${TOP_CATS[cat].me}</small></span>
        <span class="toprow__v">${topValue(cat, r.my_value)}</span>` : "";
    } catch (e) { toast(e.message, true); }
  }
  $$("#topTabs .seg__b").forEach((b) => b.addEventListener("click", () => {
    state.topCat = b.dataset.cat;
    $$("#topTabs .seg__b").forEach((x) => x.classList.toggle("active", x === b));
    haptic.tick();
    loadTop();
  }));
  $("#topList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-pid]");
    if (row) openPlayer(Number(row.dataset.pid));
  });
  $("#myRank").addEventListener("click", () => state.user && openPlayer(state.user.id));

  // ── Профиль другого игрока ────────────────────────────────
  function showcaseHTML(items, own) {
    const slots = [];
    for (let i = 0; i < 3; i++) {
      const it = items[i];
      slots.push(it ? cardHTML(it).replace('class="card"', `class="card" data-sid="${it.id}"`)
        : `<div class="showcase__empty">${own ? "Пусто" : ""}</div>`);
    }
    return slots.join("");
  }

  async function openPlayer(pid) {
    try {
      const p = await api("/api/players/" + pid);
      const since = new Date(p.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
      openModal(`<div class="pp">
        <div class="pp__head">
          <div class="avatar avatar--sm">${avatarHTML(p)}</div>
          <div><h2 class="sheet-title">${esc(p.first_name)}${p.is_me ? " (вы)" : ""}</h2>
          <small class="muted">${p.username ? "@" + esc(p.username) + ", " : ""}в игре с ${since}</small></div>
        </div>
        <div class="stats stats--3">
          <div class="stat"><small>Уровень</small><b>${p.level}</b></div>
          <div class="stat"><small>Кейсов</small><b>${fmt(p.total_spins)}</b></div>
          <div class="stat"><small>Инвентарь</small><b>${coinSvg}${fmt(p.inventory_value)}</b></div>
        </div>
        <p class="sub">Витрина</p>
        ${p.showcase.length ? `<div class="showcase">${showcaseHTML(p.showcase, false)}</div>` : '<p class="note" style="margin-top:0">Игрок пока ничего не выставил</p>'}
        <p class="sub">Лучший дроп</p>
        ${p.best_item ? `<div class="pp__best">${cardHTML(p.best_item)}<div><b>${p.best_item.stattrak ? '<span class="st">StatTrak™ </span>' : ""}${esc(p.best_item.name)}</b>
          <small class="muted">${esc(WEAR[p.best_item.wear] || "")}</small><span class="hero__price">${coinSvg}${fmt(p.best_item.price)}</span></div></div>`
          : '<p class="note" style="margin-top:0">Ещё ничего не выбил</p>'}
        <p class="note">Достижений: ${p.achievements} из ${p.achievements_total}</p>
        <div class="btns" style="margin-top:14px"><button class="btn btn--light" data-close-btn>Закрыть</button></div>
      </div>`);
      $("[data-close-btn]").onclick = closeModal;
    } catch (e) { toast(e.message, true); }
  }

  // ── Магазин ────────────────────────────────────────────────
  function renderShop() {
    const cfg = state.cfg;
    if (!cfg) return;
    $("#starsBlock").hidden = !cfg.stars_enabled;
    const owned = state.user && state.user.autosell_owned;
    const feat = (cfg.features || []).find((f) => f.id === "autosell");
    $("#featureBlock").hidden = !feat || (!cfg.stars_enabled && !owned);
    $("#buyAutosell").textContent = owned ? "Куплено" : `⭐ ${feat ? feat.stars : 250}`;
    $("#buyAutosell").disabled = !!owned;
    $("#packs").innerHTML = cfg.packs.map((p, i) => `<button class="pack" data-pack="${p.id}">
      <span class="pack__n"><svg class="ico"><use href="#i-spin"/></svg>${p.spins}</span>
      <small>круток</small><span class="pack__price">⭐ ${p.stars}</span></button>`).join("");
    $("#coinPriceHint").textContent = `· ${fmt(cfg.spin_price_coins)} за крутку`;
    const coins = state.user ? state.user.coins : 0;
    const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? "крутка" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "крутки" : "круток");
    $("#coinPacks").innerHTML = [1, 5, 10, 50, 100].map((n) => {
      const price = n * cfg.spin_price_coins;
      return `<button class="coin-row${coins < price ? " cant" : ""}" data-coins="${n}">
        <span class="coin-row__n"><svg class="ico"><use href="#i-spin"/></svg>${n}</span>
        <span class="coin-row__label">${word(n)}</span>
        <span class="coin-row__price">${coinSvg}${fmt(price)}</span></button>`;
    }).join("");
  }
  async function buyFeature(id) {
    if (!tg || !tg.openInvoice || !tg.initData) { toast("Оплата работает только внутри Telegram", true); return; }
    try {
      const { link } = await api("/api/shop/invoice", { pack_id: id });
      tg.openInvoice(link, (status) => {
        if (status === "paid") {
          haptic.ok();
          toast("Автопродажа куплена! Настройте её в профиле");
          setTimeout(async () => { setUser(await api("/api/me")); renderShop(); }, 1500);
        } else if (status === "failed") toast("Оплата не прошла", true);
      });
    } catch (e) { toast(e.message, true); }
  }
  $("#buyAutosell").addEventListener("click", () => buyFeature("autosell"));

  $("#packs").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pack]");
    if (!b) return;
    if (!tg || !tg.openInvoice || !tg.initData) { toast("Оплата работает только внутри Telegram", true); return; }
    try {
      const { link } = await api("/api/shop/invoice", { pack_id: b.dataset.pack });
      tg.openInvoice(link, async (status) => {
        if (status === "paid") {
          haptic.ok();
          toast("Оплачено! Крутки начислены");
          // бот зачисляет крутки по событию оплаты — подождём и обновим баланс
          setTimeout(async () => setUser(await api("/api/me")), 1500);
        } else if (status === "failed") toast("Оплата не прошла", true);
      });
    } catch (e) { toast(e.message, true); }
  });
  $("#coinPacks").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-coins]");
    if (!b) return;
    try {
      const r = await api("/api/shop/coins", { count: Number(b.dataset.coins) });
      setUser(r.user);
      renderShop();
      haptic.ok();
      toast(`+${b.dataset.coins} круток`);
    } catch (e) { toast(e.message, true); }
  });

  // ── Профиль и шансы ────────────────────────────────────────
  function oddsHTML() {
    if (!state.cfg) return "";
    return state.cfg.odds.map((o) => `<div class="odds__row"><span class="odds__dot" style="background:${o.color}"></span>
      ${esc(o.name)}<b>${o.chance}%</b></div>`).join("");
  }
  async function loadProfile() {
    try {
      const me = await api("/api/me");
      setUser(me);
      $("#avatar").innerHTML = avatarHTML(me);
      $("#pName").textContent = me.first_name || "Игрок";
      $("#pUser").textContent = me.username ? "@" + me.username : "";
      $("#pLevel").textContent = me.level;
      $("#pSpins").textContent = fmt(me.total_spins);
      $("#pBest").textContent = fmt(me.best_drop);
      $("#oddsTable").innerHTML = oddsHTML();
      renderMyShowcase();
      renderAutosell();
      renderChannel();
    } catch (e) { toast(e.message, true); }
  }
  // ── Автопродажа: настройки ─────────────────────────────────
  function renderAutosell() {
    const u = state.user;
    if (!u) return;
    const owned = !!u.autosell_owned;
    const a = u.autosell || { enabled: false, rarities: ["milspec"], keep_stattrak: true, max_price: null };
    $("#asLocked").hidden = owned;
    $("#asSettings").hidden = !owned || !a.enabled;
    $("#asOn").disabled = !owned;
    $("#asOn").checked = owned && a.enabled;
    const allowed = (state.cfg && state.cfg.autosell_rarities) || ["milspec", "restricted", "classified", "covert"];
    $("#asRarities").innerHTML = allowed.map((r) => `<label class="as-r${a.rarities.includes(r) ? " on" : ""}" style="--rc:${RARITY[r].color}">
      <input type="checkbox" value="${r}" ${a.rarities.includes(r) ? "checked" : ""}>${RARITY[r].name}</label>`).join("");
    $("#asKeepST").checked = a.keep_stattrak !== false;
    $("#asMax").value = a.max_price || "";
  }
  // Канал: ссылка и разовый бонус за подписку
  function renderChannel() {
    const ch = state.cfg && state.cfg.channel;
    $("#channelPanel").hidden = !ch;
    if (!ch || !state.user) return;
    const got = !!state.user.channel_bonus;
    $("#chClaim").hidden = got;
    $("#chClaim").textContent = `+${ch.bonus}`;
    $("#chText").textContent = got
      ? "Новости, промокоды и редкие дропы"
      : `За подписку — ${ch.bonus} круток`;
  }
  $("#chOpen").addEventListener("click", () => {
    const ch = state.cfg && state.cfg.channel;
    if (!ch) return;
    try {
      if (tg && tg.openTelegramLink && tg.initData) tg.openTelegramLink(ch.url);
      else window.open(ch.url, "_blank");
    } catch (e) {
      try { tg.openLink(ch.url); } catch (e2) { window.open(ch.url, "_blank"); }
    }
  });
  $("#chClaim").addEventListener("click", async () => {
    const b = $("#chClaim");
    b.disabled = true;
    try {
      const r = await api("/api/channel/claim", {});
      setUser(r.user);
      haptic.ok();
      toast(`Спасибо за подписку! +${r.bonus} круток`);
      renderChannel();
    } catch (e) {
      toast(e.message, true);
    } finally { b.disabled = false; }
  });

  let asTimer;
  async function saveAutosell() {
    const body = {
      enabled: $("#asOn").checked,
      rarities: Array.from($$("#asRarities input:checked"), (i) => i.value),
      keep_stattrak: $("#asKeepST").checked,
      max_price: parseInt($("#asMax").value, 10) || null,
    };
    try {
      const r = await api("/api/autosell", body);
      setUser(r.user);
      renderAutosell();
      toast(body.enabled ? "Автопродажа сохранена" : "Автопродажа выключена");
    } catch (e) { toast(e.message, true); }
  }
  $("#asOn").addEventListener("change", saveAutosell);
  $("#asKeepST").addEventListener("change", saveAutosell);
  $("#asRarities").addEventListener("change", saveAutosell);
  $("#asMax").addEventListener("input", () => { clearTimeout(asTimer); asTimer = setTimeout(saveAutosell, 700); });

  function renderMyShowcase() {
    const items = (state.user && state.user.showcase) || [];
    $("#myShowcase").innerHTML = showcaseHTML(items, true);
    $("#showcaseHint").hidden = items.length >= 3;
  }
  $("#myShowcase").addEventListener("click", (e) => {
    const c = e.target.closest("[data-sid]");
    if (!c) return;
    const it = state.user.showcase.find((x) => String(x.id) === c.dataset.sid);
    if (it) showItem(it);
  });
  $("#openMyProfile").addEventListener("click", () => state.user && openPlayer(state.user.id));

  $("#soundToggle").addEventListener("change", (e) => {
    sound.on = e.target.checked;
    try { localStorage.setItem("sound", sound.on ? "1" : ""); } catch (err) {}
    if (sound.on) sound.win("restricted");
  });

  $("#oddsBtn").addEventListener("click", () => {
    openModal(`<h2 style="margin:0 0 4px">Шансы выпадения</h2>
      <p class="sub" style="margin-top:0">Как в кейсах CS2. Каждый предмет также получает
      случайный износ (float), а с шансом 10% — StatTrak™ (цена ×2).</p>
      <div class="odds">${oddsHTML()}</div>
      <div class="btns" style="margin-top:14px"><button class="btn btn--light" data-close-btn>Понятно</button></div>`);
    $("[data-close-btn]").onclick = closeModal;
  });

  // ── Админ-панель ───────────────────────────────────────────
  const A = { kind: "spins", skin: null, timer: null };
  const ACTIONS = { give_spins: "крутки", give_coins: "монеты", give_skin: "скин", give_all_spins: "крутки", give_all_coins: "монеты", promo_create: "промокод", maintenance_on: "техработы", maintenance_off: "техработы" };
  const when = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  async function loadAdmin() {
    renderAdminFeats();
    try {
      const r = await api("/api/admin/stats");
      const s = r.stats;
      $("#aStats").innerHTML = [
        ["Игроков", `${fmt(s.users)} <small class="muted">+${fmt(s.users_24h)}</small>`],
        ["Круток за сутки", fmt(s.spins_24h)],
        ["Круток всего", fmt(s.spins)],
        ["Покупок", `${fmt(s.purchases)} · ⭐ ${fmt(s.stars)}`],
      ].map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join("");
      $("#aPurchases").innerHTML = r.purchases.length
        ? r.purchases.map((p) => `<div><span>${esc(p.first_name || p.user_id)} · ${p.spins} круток за ⭐${p.stars}</span><small>${when(p.created_at)}</small></div>`).join("")
        : '<div><span class="muted">Покупок пока нет</span></div>';
      $("#aLog").innerHTML = r.log.length
        ? r.log.map((l) => {
            if (l.action === "maintenance_on" || l.action === "maintenance_off") {
              return `<div><span>${l.action === "maintenance_on" ? "включены техработы" : "выключены техработы"}</span><small>${when(l.created_at)}</small></div>`;
            }
            if (l.action === "feature_on" || l.action === "feature_off") {
              return `<div><span>${esc(l.details)} ${l.action === "feature_on" ? "выдана" : "забрана"} → ${esc(l.first_name || l.target_id)}</span><small>${when(l.created_at)}</small></div>`;
            }
            if (l.action === "channel_post") {
              return `<div><span>пост в канал: ${esc(l.details || "")}</span><small>${when(l.created_at)}</small></div>`;
            }
            if (l.action === "promo_create") {
              return `<div><span>создан промокод ${esc(l.details)}</span><small>${when(l.created_at)}</small></div>`;
            }
            const all = l.action.startsWith("give_all");
            const who = all ? "всем" : esc(l.first_name || l.target_id);
            const what = l.action === "give_skin" ? esc(l.details)
              : (l.amount > 0 ? "+" : "") + fmt(l.amount) + (all && l.details ? `, ${esc(l.details)}` : "");
            return `<div><span>${ACTIONS[l.action] || l.action} → ${who}: ${what}</span><small>${when(l.created_at)}</small></div>`;
          }).join("")
        : '<div><span class="muted">Пусто</span></div>';
    } catch (e) { toast(e.message, true); }
  }

  function targetUser() {
    const v = $("#aUser").value.trim();
    if (!v) { toast("Укажите игрока: @username или ID", true); return null; }
    return v;
  }

  async function adminGive(user, kind, amount) {
    try {
      const r = await api("/api/admin/give", { user, kind, amount });
      if (r.user.id === state.user.id) setUser(r.user);
      haptic.ok();
      toast(`${r.user.first_name}: ${amount > 0 ? "+" : ""}${fmt(amount)} ${kind === "spins" ? "круток" : "монет"}`);
      if ($("#aUser").value.trim()) findUser(true);
      loadAdmin();
    } catch (e) { toast(e.message, true); }
  }

  async function findUser(silent) {
    const q = targetUser();
    if (!q) return;
    try {
      const u = await api("/api/admin/user?q=" + encodeURIComponent(q));
      if (!$("#gsUser").value.trim()) { $("#gsUser").value = String(u.id); lookupRecipient(); }
      A.found = u;
      const feats = featureList().filter((f) => u[f.id + "_owned"]).map((f) => f.title);
      $("#aUserCard").hidden = false;
      $("#aUserCard").innerHTML = `<b>${esc(u.first_name)} ${u.username ? "@" + esc(u.username) : ""}</b>
        <small>ID ${u.id} · уровень ${u.level} · в игре с ${new Date(u.created_at).toLocaleDateString("ru-RU")}</small>
        <small>Круток: ${fmt(u.spins)} · монет: ${fmt(u.coins)} · предметов: ${fmt(u.inventory_count)} на ${fmt(u.inventory_value)}</small>
        <small>Привилегии: ${feats.length ? esc(feats.join(", ")) : "нет"}</small>`;
    } catch (e) {
      A.found = null;
      $("#aUserCard").hidden = true;
      if (!silent) toast(e.message, true);
    }
    renderAdminFeats();
  }

  // Донат-привилегии: выдать/забрать игроку из поля «Игрок»
  const featureList = () => (state.cfg && state.cfg.features) || [];
  function renderAdminFeats() {
    const u = A.found;
    const same = u && [String(u.id), "@" + (u.username || "").toLowerCase(), (u.username || "").toLowerCase()]
      .includes($("#aUser").value.trim().toLowerCase());
    $("#aFeats").innerHTML = featureList().map((f) => {
      const owned = same && u[f.id + "_owned"];
      const status = !same ? "Найдите игрока, чтобы увидеть статус" : owned ? "Есть у игрока" : "Нет у игрока";
      return `<div class="a-feat">
        <div><b>${esc(f.title)}</b><small class="${owned ? "is-on" : ""}">${status}</small></div>
        <button class="btn btn--sm ${owned ? "btn--ghost" : "btn--light"}" data-feat="${esc(f.id)}" data-on="${owned ? 0 : 1}">${owned ? "Забрать" : "Выдать"}</button>
      </div>`;
    }).join("") || '<p class="note">Улучшений нет</p>';
  }
  $("#aFeats").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-feat]");
    if (!b) return;
    const user = targetUser();
    if (!user) return;
    const on = b.dataset.on === "1";
    const title = (featureList().find((f) => f.id === b.dataset.feat) || {}).title;
    b.disabled = true;
    try {
      const r = await api("/api/admin/feature", { user, feature: b.dataset.feat, on });
      if (r.user.id === state.user.id) { setUser(r.user); renderAutosell(); }
      haptic.ok();
      toast(`${title}: ${on ? "выдано" : "забрано"} — ${r.user.first_name} (ID ${r.user.id})` +
        (r.created ? ". Игрок ещё не заходил, привилегия его дождётся" : ""));
      await findUser(true);
      loadAdmin();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
  $("#aUser").addEventListener("input", renderAdminFeats);

  $$("[data-self]").forEach((b) => b.addEventListener("click", () => {
    const [kind, amount] = b.dataset.self.split(":");
    adminGive(String(state.user.id), kind, Number(amount));
  }));
  $("#aFind").addEventListener("click", () => findUser(false));
  $("#aUser").addEventListener("keydown", (e) => { if (e.key === "Enter") findUser(false); });
  $$("#aKind .seg__b").forEach((b) => b.addEventListener("click", () => {
    A.kind = b.dataset.kind;
    $$("#aKind .seg__b").forEach((x) => x.classList.toggle("active", x === b));
  }));
  $("#aGive").addEventListener("click", () => {
    const user = targetUser();
    const amount = parseInt($("#aAmount").value, 10);
    if (!user) return;
    if (!amount) { toast("Укажите количество", true); return; }
    adminGive(user, A.kind, amount);
  });

  // Выдача скина: получатель, поиск, выбранный скин, допустимые износы
  const WEAR_BANDS = { FN: [0, 0.07], MW: [0.07, 0.15], FT: [0.15, 0.38], WW: [0.38, 0.45], BS: [0.45, 1] };
  const skinRow = (s) => `<button class="a-skin${A.skin && A.skin.id === s.id ? " sel" : ""}" data-skin="${esc(s.id)}">
      <i style="background:${RARITY[s.rarity].color}"></i>
      <span class="a-skin__img">${s.image ? `<img src="${esc(imgUrl(s.image))}" alt="" loading="lazy">` : ""}</span>
      <span class="a-skin__name">${esc(s.name)}</span></button>`;

  async function lookupRecipient() {
    const q = $("#gsUser").value.trim();
    const card = $("#gsUserCard");
    if (!q) { card.hidden = true; return null; }
    try {
      const u = await api("/api/admin/user?q=" + encodeURIComponent(q));
      card.hidden = false;
      card.classList.remove("is-err");
      card.innerHTML = `<b>${esc(u.first_name)} ${u.username ? "@" + esc(u.username) : ""}</b><small>ID ${u.id}, уровень ${u.level}</small>`;
      return u;
    } catch (e) {
      card.hidden = false;
      card.classList.add("is-err");
      card.innerHTML = `<small>${esc(e.message)}</small>`;
      return null;
    }
  }
  let gsTimer;
  $("#gsUser").addEventListener("input", () => { clearTimeout(gsTimer); gsTimer = setTimeout(lookupRecipient, 400); });
  $("#gsMe").addEventListener("click", () => {
    $("#gsUser").value = String(state.user.id);
    lookupRecipient();
  });

  $("#aSkinQ").addEventListener("input", () => {
    clearTimeout(A.timer);
    A.timer = setTimeout(async () => {
      const q = $("#aSkinQ").value.trim();
      if (q.length < 2) { $("#aSkins").innerHTML = ""; return; }
      try {
        A.found = await api("/api/admin/skins?q=" + encodeURIComponent(q));
        $("#aSkins").innerHTML = A.found.length ? A.found.map(skinRow).join("")
          : '<div class="muted" style="padding:6px 8px">Ничего не найдено</div>';
      } catch (e) { toast(e.message, true); }
    }, 250);
  });

  function pickSkin(s) {
    A.skin = s;
    $("#aSkins").innerHTML = "";
    $("#aSkinQ").value = "";
    $("#aPicked").hidden = false;
    $("#aPicked").innerHTML = skinRow(s).replace('class="a-skin', 'class="a-skin sel') + '<button class="link" id="aUnpick">Изменить</button>';
    $("#aUnpick").onclick = () => { A.skin = null; $("#aPicked").hidden = true; $("#aSkinQ").focus(); refreshGiveBtn(); };
    // износы, которых у этого скина не бывает, выбрать нельзя
    $$("#aWear option").forEach((o) => {
      const band = WEAR_BANDS[o.value];
      o.disabled = !!band && !(Math.max(band[0], s.min_float) < Math.min(band[1], s.max_float));
    });
    if ($("#aWear").selectedOptions[0].disabled) $("#aWear").value = "";
    $("#aST").disabled = !s.stattrak;
    if (!s.stattrak) $("#aST").checked = false;
    refreshGiveBtn();
  }
  function refreshGiveBtn() {
    $("#aGiveSkin").disabled = !A.skin;
    $("#aGiveSkin").textContent = A.skin ? "Выдать скин" : "Выберите скин";
  }
  $("#aSkins").addEventListener("click", (e) => {
    const b = e.target.closest("[data-skin]");
    const s = b && (A.found || []).find((x) => x.id === b.dataset.skin);
    if (s) pickSkin(s);
  });
  $("#aGiveSkin").addEventListener("click", async () => {
    const user = $("#gsUser").value.trim();
    if (!user) { toast("Укажите, кому выдать: @username, ID или «Себе»", true); $("#gsUser").focus(); return; }
    if (!A.skin) return;
    $("#aGiveSkin").disabled = true;
    try {
      const r = await api("/api/admin/give-skin", { user, skin_id: A.skin.id, wear: $("#aWear").value || null, stattrak: $("#aST").checked });
      haptic.ok();
      toast(`${r.user.first_name} получил ${r.item.name} (${r.item.wear}, float ${Number(r.item.float).toFixed(4)})`);
      if (r.user.id === state.user.id) setUser(await api("/api/me"));
      loadAdmin();
    } catch (e) { toast(e.message, true); }
    refreshGiveBtn();
  });

  // ── Одно устройство одновременно ───────────────────────────
  const session = { locked: false, retryTimer: null };

  function lockSession(message) {
    if (session.locked) return;
    session.locked = true;
    closeModal();
    $("#lockText").textContent = message || "SkinDrop уже открыт на другом устройстве.";
    $("#lock").hidden = false;
    haptic.err();
    // пробуем сами раз в 5 секунд — как только на другом устройстве закроют, пустит
    session.retryTimer = setInterval(() => claimSession(true), 5000);
  }

  function unlockSession() {
    if (!session.locked) return;
    session.locked = false;
    clearInterval(session.retryTimer);
    $("#lock").hidden = true;
    loadAll();
  }

  async function claimSession(silent, force) {
    try {
      await api("/api/session", { sid: SID, force: !!force });
      unlockSession();
      return true;
    } catch (e) {
      if (!silent && !session.locked && !maint.on) toast(e.message, true);
      return false;
    }
  }

  function releaseSession() {
    const body = JSON.stringify({ sid: SID, init_data: tg && tg.initData ? tg.initData : null, dev_user: tg && tg.initData ? null : devUser() });
    try {
      navigator.sendBeacon(API + "/api/session/release", new Blob([body], { type: "text/plain" }));
    } catch (e) {}
  }

  // «Играть здесь» — забрать игру с другого устройства
  $("#lockRetry").addEventListener("click", async () => {
    $("#lockRetry").disabled = true;
    const ok = await claimSession(true, true);
    $("#lockRetry").disabled = false;
    if (ok) { haptic.ok(); toast("Игра перенесена на это устройство"); }
    else toast("Не получилось, попробуйте ещё раз", true);
  });

  // пинг: «я ещё открыт»
  const active = { on: true };
  setInterval(() => { if (active.on && !document.hidden && !session.locked) claimSession(true); }, 7000);
  const goAway = () => { active.on = false; if (!session.locked) releaseSession(); };
  const comeBack = () => { active.on = true; claimSession(true); };
  document.addEventListener("visibilitychange", () => (document.hidden ? goAway() : comeBack()));
  window.addEventListener("pagehide", goAway);
  // Telegram сообщает, когда мини-приложение свернули или развернули (Bot API 8.0+)
  try {
    if (tg && tg.onEvent) {
      tg.onEvent("deactivated", goAway);
      tg.onEvent("activated", comeBack);
    }
  } catch (e) {}

  // ── Контракт обмена ────────────────────────────────────────
  const TU_NEXT = { milspec: "restricted", restricted: "classified", classified: "covert", covert: "gold" };
  const tu = { rarity: "milspec", items: [], picked: new Set() };

  async function loadTradeup() {
    tu.picked.clear();
    try {
      tu.items = await api(`/api/inventory?limit=500&sort=cheap&rarity=${tu.rarity}`);
    } catch (e) { toast(e.message, true); tu.items = []; }
    $("#tuGrid").innerHTML = tu.items.map((d) => cardHTML(d, "", true).replace('class="card"', `class="card" data-tu="${d.id}"`)).join("");
    const need = 10 - tu.items.length;
    $("#tuEmpty").hidden = need <= 0;
    $("#tuEmpty").textContent = need > 0
      ? (tu.items.length ? `Нужно ещё ${need} скинов этой редкости — сейчас ${tu.items.length}.` : "Скинов этой редкости пока нет. Крутите кейсы!")
      : "";
    renderTradeup();
  }

  function renderTradeup() {
    const n = tu.picked.size;
    const picked = tu.items.filter((d) => tu.picked.has(d.id));
    $("#tuSlots").innerHTML = `<b>${n} / 10</b>` + Array.from({ length: 10 }, (_, i) =>
      `<i style="${i < n ? `background:${RARITY[tu.rarity].color}` : ""}"></i>`).join("");
    const out = TU_NEXT[tu.rarity];
    const st = n === 10 && picked.every((d) => d.stattrak);
    const value = picked.reduce((a, d) => a + d.price, 0);
    $("#tuOut").innerHTML = `<span>Получите</span><b style="color:${RARITY[out].color}">${st ? "StatTrak™ " : ""}${RARITY[out].name}</b>`
      + (n ? `<small>Вы отдаёте ${coinSvg}${fmt(value)}</small>` : "");
    $$("#tuGrid .card").forEach((c) => c.classList.toggle("picked-tu", tu.picked.has(Number(c.dataset.tu))));
    $("#tuSign").disabled = n !== 10;
    $("#tuSign").textContent = n === 10 ? "Подписать" : `Выберите ещё ${10 - n}`;
    $("#tuFill").disabled = tu.items.length < 10 || n === 10;
  }

  $$("#tuTabs .seg__b").forEach((b) => b.addEventListener("click", () => {
    tu.rarity = b.dataset.r;
    $$("#tuTabs .seg__b").forEach((x) => x.classList.toggle("active", x === b));
    haptic.tick();
    loadTradeup();
  }));
  $("#tuGrid").addEventListener("click", (e) => {
    const c = e.target.closest("[data-tu]");
    if (!c) return;
    const id = Number(c.dataset.tu);
    if (tu.picked.has(id)) tu.picked.delete(id);
    else if (tu.picked.size < 10) tu.picked.add(id);
    else { toast("Уже выбрано 10 предметов", true); return; }
    haptic.tick();
    renderTradeup();
  });
  $("#tuFill").addEventListener("click", () => {
    // список отсортирован от дешёвых к дорогим; витринные не трогаем
    for (const d of tu.items) {
      if (tu.picked.size >= 10) break;
      if (!onShowcase(d.id)) tu.picked.add(d.id);
    }
    haptic.tick();
    renderTradeup();
  });
  $("#tuSign").addEventListener("click", () => {
    const out = TU_NEXT[tu.rarity];
    const value = tu.items.filter((d) => tu.picked.has(d.id)).reduce((a, d) => a + d.price, 0);
    openModal(`<h2 class="sheet-title">Подписать контракт?</h2>
      <p class="sub" style="margin-top:4px">10 предметов на ${coinSvg}${fmt(value)} будут обменены на 1 случайный скин редкости
      «${RARITY[out].name}». Отменить нельзя.</p>
      <div class="btns"><button class="btn btn--ghost" data-close-btn>Отмена</button>
      <button class="btn btn--light" id="tuGo">Подписать</button></div>`);
    $("[data-close-btn]").onclick = closeModal;
    $("#tuGo").onclick = async () => {
      $("#tuGo").disabled = true;
      try {
        const r = await api("/api/tradeup", { ids: [...tu.picked] });
        if (r.achievements_ready != null) setUser({ achievements_ready: r.achievements_ready });
        await preload(imgUrl(r.item.image));
        haptic.ok();
        sound.win(r.item.rarity);
        openModal(`<p class="sub" style="margin:0 0 4px;text-align:center">Результат контракта</p>${dropHTML(r.item)}
          <div class="btns"><button class="btn btn--ghost" id="tuMore">Ещё контракт</button>
          <button class="btn btn--light" data-close-btn>Готово</button></div>`);
        $("[data-close-btn]").onclick = closeModal;
        $("#tuMore").onclick = closeModal;
        loadTradeup();
      } catch (e) { toast(e.message, true); closeModal(); loadTradeup(); }
    };
  });

  // ── Админка: выдать всем ───────────────────────────────────
  const GA = { kind: "spins" };
  $$("#gaKind .seg__b").forEach((b) => b.addEventListener("click", () => {
    GA.kind = b.dataset.kind;
    $$("#gaKind .seg__b").forEach((x) => x.classList.toggle("active", x === b));
  }));
  $("#gaGive").addEventListener("click", async () => {
    const amount = parseInt($("#gaAmount").value, 10);
    if (!amount || amount < 1) { toast("Укажите, сколько выдать каждому", true); return; }
    const days = Number($("#gaDays").value);
    let count;
    try { count = (await api("/api/admin/give-all/preview?active_days=" + days)).count; }
    catch (e) { toast(e.message, true); return; }
    if (!count) { toast("Нет игроков под этот фильтр", true); return; }
    const what = GA.kind === "spins" ? "круток" : "монет";
    const notify = $("#gaNotify").checked;
    openModal(`<h2 class="sheet-title">Выдать всем?</h2>
      <p class="sub" style="margin-top:4px">По ${fmt(amount)} ${what} получат <b style="color:var(--text)">${fmt(count)} игроков</b>.
      ${notify ? "Каждому придёт сообщение от бота." : "Без уведомления."}</p>
      <div class="btns"><button class="btn btn--ghost" data-close-btn>Отмена</button>
      <button class="btn btn--light" id="gaGo">Выдать</button></div>`);
    $("[data-close-btn]").onclick = closeModal;
    $("#gaGo").onclick = async () => {
      $("#gaGo").disabled = true;
      try {
        const r = await api("/api/admin/give-all", {
          kind: GA.kind, amount, active_days: days, reason: $("#gaReason").value, notify,
        });
        setUser(r.user);
        closeModal();
        haptic.ok();
        toast(`Выдано ${fmt(r.count)} игрокам` + (r.notified ? ", рассылка идёт" : ""));
        $("#gaAmount").value = "";
        loadAdmin();
      } catch (e) { toast(e.message, true); closeModal(); }
    };
  });

  // ── Промокоды: игрок ───────────────────────────────────────
  async function activatePromo() {
    const code = $("#promoInput").value.trim();
    if (!code) { toast("Введите промокод", true); return; }
    $("#promoBtn").disabled = true;
    try {
      const r = await api("/api/promo", { code });
      setUser(r.user);
      haptic.ok();
      sound.coins();
      const parts = [];
      if (r.spins) parts.push(`+${fmt(r.spins)} круток`);
      if (r.coins) parts.push(`+${fmt(r.coins)} монет`);
      toast("Промокод активирован: " + parts.join(" и "));
      $("#promoInput").value = "";
    } catch (e) { toast(e.message, true); }
    $("#promoBtn").disabled = false;
  }
  $("#promoBtn").addEventListener("click", activatePromo);
  $("#promoInput").addEventListener("keydown", (e) => { if (e.key === "Enter") activatePromo(); });

  // ── Промокоды: админка ─────────────────────────────────────
  const PC = { mode: "limit" };
  async function loadPromos() {
    try {
      const list = await api("/api/admin/promo");
      $("#pcList").innerHTML = list.length ? list.map((p) => {
        const uses = p.max_uses == null ? `${fmt(p.uses)} акт., для всех` : `${fmt(p.uses)} из ${fmt(p.max_uses)}`;
        const expired = p.expires_at && new Date(p.expires_at) < new Date();
        const ended = p.max_uses != null && p.uses >= p.max_uses;
        const state = !p.active ? "выключен" : expired ? "истёк" : ended ? "закончился" : p.expires_at ? `до ${when(p.expires_at)}` : "активен";
        return `<div class="promo${p.active && !expired && !ended ? "" : " is-off"}">
          <div class="promo__main"><b class="promo__code" data-copy="${esc(p.code)}">${esc(p.code)}</b>
            <small>${esc(p.reward)}, ${uses}, ${state}</small></div>
          <button class="chip" data-pc="${esc(p.code)}" data-on="${p.active ? 0 : 1}">${p.active ? "Выключить" : "Включить"}</button>
        </div>`;
      }).join("") : '<div class="a-log"><div><span class="muted">Промокодов пока нет</span></div></div>';
    } catch (e) { toast(e.message, true); }
  }
  $$("#pcMode .seg__b").forEach((b) => b.addEventListener("click", () => {
    PC.mode = b.dataset.mode;
    $$("#pcMode .seg__b").forEach((x) => x.classList.toggle("active", x === b));
    $("#pcUses").hidden = PC.mode !== "limit";
  }));
  $("#pcCreate").addEventListener("click", async () => {
    const spins = parseInt($("#pcSpins").value, 10) || 0;
    const coins = parseInt($("#pcCoins").value, 10) || 0;
    const uses = parseInt($("#pcUses").value, 10);
    if (!spins && !coins) { toast("Укажите крутки и/или монеты", true); return; }
    if (PC.mode === "limit" && !(uses > 0)) { toast("Укажите количество активаций", true); return; }
    try {
      const p = await api("/api/admin/promo", {
        code: $("#pcCode").value.trim() || null, spins, coins,
        max_uses: PC.mode === "limit" ? uses : null,
        expires_days: $("#pcDays").value ? Number($("#pcDays").value) : null,
      });
      haptic.ok();
      try { await navigator.clipboard.writeText(p.code); toast(`Промокод ${p.code} создан и скопирован`); }
      catch (err) { toast(`Промокод ${p.code} создан`); }
      ["#pcCode", "#pcSpins", "#pcCoins", "#pcUses"].forEach((sel) => ($(sel).value = ""));
      loadPromos();
      loadAdmin();
    } catch (e) { toast(e.message, true); }
  });
  $("#pcList").addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast("Скопировано: " + copy.dataset.copy); } catch (err) {}
      return;
    }
    const b = e.target.closest("[data-pc]");
    if (!b) return;
    try {
      await api(`/api/admin/promo/${encodeURIComponent(b.dataset.pc)}/active?active=${b.dataset.on === "1"}`, {});
      loadPromos();
    } catch (err) { toast(err.message, true); }
  });

  // ── Технические работы ─────────────────────────────────────
  const maint = { on: false, timer: null };
  function showMaintenance(message) {
    if (message) $("#maintText").textContent = message;
    if (maint.on) return;
    maint.on = true;
    closeModal();
    $("#maint").hidden = false;
    maint.timer = setInterval(async () => {
      try {
        const st = await fetch(API + "/api/status").then((r) => r.json());
        if (st.maintenance) { $("#maintText").textContent = st.message; return; }
        clearInterval(maint.timer);
        maint.on = false;
        $("#maint").hidden = true;
        if (await claimSession(true)) loadAll();
      } catch (e) {}
    }, 15000);
  }

  // для админа: плашка сверху и переключатель в админ-панели
  function renderMaintAdmin(on) {
    $("#maintBar").hidden = !on;
    $("#maintState").textContent = on
      ? "Режим включён: игроки видят заглушку, вы — обычное приложение."
      : "Режим выключен: игроки играют как обычно.";
    $("#maintToggle").textContent = on ? "Выключить техработы" : "Включить техработы";
    $("#maintToggle").dataset.on = on ? "1" : "";
  }
  async function setMaintenance(on) {
    try {
      const r = await api("/api/admin/maintenance", { on, message: on ? ($("#maintMsg").value.trim() || null) : null });
      renderMaintAdmin(r.maintenance);
      haptic.ok();
      toast(r.maintenance ? "Техработы включены" : "Техработы выключены");
      loadAdmin();
    } catch (e) { toast(e.message, true); }
  }
  $("#maintToggle").addEventListener("click", () => {
    const on = !$("#maintToggle").dataset.on;
    if (!on) { setMaintenance(false); return; }
    openModal(`<h2 class="sheet-title">Включить техработы?</h2>
      <p class="sub" style="margin-top:4px">Все игроки, кроме админов, увидят заглушку
      «${esc($("#maintMsg").value.trim() || "Идут технические работы. Скоро вернёмся!")}».</p>
      <div class="btns"><button class="btn btn--ghost" data-close-btn>Отмена</button>
      <button class="btn btn--light" id="maintGo">Включить</button></div>`);
    $("[data-close-btn]").onclick = closeModal;
    $("#maintGo").onclick = () => { closeModal(); setMaintenance(true); };
  });
  $("#maintOffBar").addEventListener("click", () => setMaintenance(false));

  // ── Сервер недоступен («Скоро вернёмся») ───────────────────
  const down = { on: false, timer: null, left: 0, waiters: [] };
  async function serverAlive() {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    try {
      const r = await fetch(API + "/api/status?t=" + Date.now(), { cache: "no-store", signal: c.signal });
      const j = r.ok ? await r.json() : null;
      return !!(j && (j.ok || j.maintenance !== undefined));
    } catch (e) { return false; } finally { clearTimeout(t); }
  }
  function serverDown() {
    if (down.on) return;
    down.on = true;
    closeModal();
    loader.hide();
    $("#down").hidden = false;
    down.left = 15;
    clearInterval(down.timer);
    down.timer = setInterval(() => {
      down.left--;
      $("#downHint").textContent = `Проверим снова через ${down.left} с`;
      if (down.left <= 0) checkServer();
    }, 1000);
  }
  async function checkServer() {
    down.left = 15;
    $("#downRetry").disabled = true;
    $("#downHint").textContent = "Проверяем…";
    const ok = await serverAlive();
    $("#downRetry").disabled = false;
    if (!ok) { $("#downHint").textContent = `Проверим снова через ${down.left} с`; return false; }
    clearInterval(down.timer);
    down.on = false;
    $("#down").hidden = true;
    const w = down.waiters.splice(0);
    if (w.length) w.forEach((f) => f());
    else if (await claimSession(true)) loadAll();
    return true;
  }
  $("#downRetry").addEventListener("click", () => { haptic.tap && haptic.tap(); checkServer(); });
  // при старте: ждём, пока сервер ответит (если не отвечает — показываем «Скоро вернёмся»)
  function waitForServer() {
    return serverAlive().then((ok) => ok || new Promise((res) => { down.waiters.push(res); serverDown(); }));
  }
  async function resolveApi() {
    if (API) return;
    try {
      const r = await fetch("server.json?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.url) API = String(j.url).replace(/\/+$/, "");
      }
    } catch (e) {}
  }

  // ── Загрузочный экран ──────────────────────────────────────
  const loader = {
    total: 0, done: 0, finished: false,
    track(p) {
      this.total++;
      Promise.resolve(p).finally(() => { this.done++; this.render(); });
      this.render();
      return p;
    },
    hint(t) { $("#loaderHint").textContent = t; },
    render() {
      if (this.finished) return;
      const k = this.total ? this.done / this.total : 0;
      $("#loaderBar").style.width = Math.max(6, Math.round(k * 100)) + "%";
    },
    hide() {
      if (this.finished) return;
      this.finished = true;
      $("#loaderBar").style.width = "100%";
      setTimeout(() => {
        $("#loader").classList.add("is-done");
        setTimeout(() => $("#loader").remove(), 450);
      }, 180);
    },
  };

  // ── Старт ──────────────────────────────────────────────────
  async function loadAll(initial) {
    const t = initial ? (p) => loader.track(p) : (p) => p;
    try {
      const [cfg, me] = await t(Promise.all([api("/api/config"), api("/api/me")]));
      state.cfg = cfg;
      setUser(me);
    } catch (e) {
      toast(e.message, true);
    }
    if (initial) loader.hint("Загружаем скины");
    const images = [];
    const strip = fillIdleStrip(initial ? (p) => images.push(t(p)) : null);
    const poolImgs = refreshPool(initial ? (p) => images.push(t(p)) : null);
    loadFeed();
    if (initial) {
      await Promise.all([strip, poolImgs]);
      await Promise.all(images);
    }
  }

  (async function init() {
    try { sound.on = localStorage.getItem("sound") === "1"; } catch (e) {}
    $("#soundToggle").checked = sound.on;
    loader.render();
    const failSafe = setTimeout(() => loader.hide(), 7000); // медленный интернет — не держим дольше
    await resolveApi();
    await waitForServer();
    if (await loader.track(claimSession(false))) await loadAll(true);
    clearTimeout(failSafe);
    loader.hide();
  })();
})();
