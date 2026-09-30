/* Gestão de Tráfego · Pedro Granado Imóveis */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const TOKEN_KEY = "pg-trafego:token";
  const PERIOD_KEY = "pg-trafego:period";
  const FONT = "Manrope, system-ui, sans-serif";

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* armazenamento indisponível */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* armazenamento indisponível */ } },
  };

  const nfInt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const nfBrl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const F = {
    int: (n) => (n == null ? "–" : nfInt.format(Math.round(n))),
    brl: (n) => (n == null ? "–" : nfBrl.format(n)),
    brlShort: (n) => (Math.abs(n) >= 1000 ? `R$ ${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : `R$ ${nfInt.format(n)}`),
    pct: (n, d = 2) => (n == null ? "–" : `${n.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })}%`),
    d: (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : ""),
    date: (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ""),
    dt: (ts) => new Date(ts).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    bytes: (n) => (n > 1048576 ? `${(n / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`),
  };
  const range = (from, to) => (from === to ? F.date(from) : `${F.d(from)} a ${F.date(to)}`);

  const todaySP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const change = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : ((cur - prev) / prev) * 100);

  const STATUS = {
    ACTIVE: ["Ativa", "active"], PAUSED: ["Pausada", "paused"], CAMPAIGN_PAUSED: ["Pausada", "paused"],
    ADSET_PAUSED: ["Conjuntos pausados", "paused"], ARCHIVED: ["Arquivada", ""], DELETED: ["Excluída", ""],
    IN_PROCESS: ["Em processamento", ""], WITH_ISSUES: ["Com problemas", "error"], PENDING_REVIEW: ["Em análise", "paused"],
    DISAPPROVED: ["Reprovada", "error"], PREAPPROVED: ["Pré-aprovada", ""], PENDING_BILLING_INFO: ["Pendência de pagamento", "error"],
  };
  const OBJECTIVES = {
    OUTCOME_LEADS: "Cadastros", OUTCOME_TRAFFIC: "Tráfego", OUTCOME_ENGAGEMENT: "Engajamento", OUTCOME_AWARENESS: "Reconhecimento",
    OUTCOME_SALES: "Vendas", OUTCOME_APP_PROMOTION: "Promoção de app", LEAD_GENERATION: "Cadastros", LINK_CLICKS: "Tráfego",
    MESSAGES: "Mensagens", REACH: "Alcance", BRAND_AWARENESS: "Reconhecimento", POST_ENGAGEMENT: "Engajamento", CONVERSIONS: "Conversões",
  };
  const statusPill = (s) => { const [label, cls] = STATUS[s] || [s || "Sem status", ""]; return `<span class="pill ${cls}">${esc(label)}</span>`; };
  const objective = (o) => OBJECTIVES[o] || (o ? o.replace(/_/g, " ").toLowerCase() : "Objetivo não informado");
  const budget = (c) => (c.daily_budget ? `${F.brl(c.daily_budget)}/dia` : c.lifetime_budget ? `${F.brl(c.lifetime_budget)} total` : "Orçamento nos conjuntos");
  const byActiveThenName = (a, b) => (b.effective_status === "ACTIVE") - (a.effective_status === "ACTIVE") || a.name.localeCompare(b.name, "pt-BR");

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  const PRESETS = [
    ["hoje", "Hoje"], ["ontem", "Ontem"], ["7d", "Últimos 7 dias"], ["30d", "Últimos 30 dias"],
    ["mes", "Este mês"], ["mes-anterior", "Mês anterior"], ["custom", "Personalizado"],
  ];

  function presetRange(p) {
    const t = todaySP();
    const y = addDays(t, -1);
    switch (p) {
      case "hoje": return [t, t];
      case "ontem": return [y, y];
      case "30d": return [addDays(y, -29), y];
      case "mes": return [`${t.slice(0, 8)}01`, t];
      case "mes-anterior": { const last = addDays(`${t.slice(0, 8)}01`, -1); return [`${last.slice(0, 8)}01`, last]; }
      default: return [addDays(y, -6), y];
    }
  }

  function loadPeriod() {
    let saved = null;
    try { saved = JSON.parse(store.get(PERIOD_KEY) || "null"); } catch { /* valor inválido */ }
    if (saved?.preset === "custom" && saved.from && saved.to) return saved;
    const preset = saved?.preset && saved.preset !== "custom" ? saved.preset : "7d";
    const [from, to] = presetRange(preset);
    return { preset, from, to };
  }

  const state = { token: store.get(TOKEN_KEY), period: loadPeriod(), ticket: 0, charts: [] };

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  async function api(action, payload = {}) {
    let res;
    try {
      res = await fetch(CFG.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-token": state.token || "" },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch {
      throw new Error("Sem conexão com o servidor. Verifique a internet e tente novamente.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && action !== "ping") {
      logout("Sessão encerrada. Informe o token novamente.");
      throw new Error("Não autorizado.");
    }
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Avisos
  // ---------------------------------------------------------------------------

  function toast(msg, type = "") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? 6000 : 3500);
  }

  async function busy(btn, label, fn) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(label)}`;
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = original; }
  }

  // ---------------------------------------------------------------------------
  // Ícones
  // ---------------------------------------------------------------------------

  const ICON = {
    painel: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
    campanhas: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    relatorios: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    telegram: '<path d="M21 4 3 11l6 2.5M21 4l-3 16-9-6.5M21 4 9 13.5V19l3.5-3.5"/>',
    sistema: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  const NAV = [["painel", "Painel"], ["campanhas", "Campanhas"], ["relatorios", "Relatórios"], ["telegram", "Telegram"], ["sistema", "Sistema"]];

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  const brand = `<div class="brand"><div class="brand-mark">PG</div><div><div class="brand-name">Pedro Granado</div><div class="brand-sub">Gestão de Tráfego</div></div></div>`;

  function renderLogin(message = "") {
    destroyCharts();
    $("#app").innerHTML = `
      <div class="login">
        <form class="login-card" id="login-form" autocomplete="off">
          ${brand}
          <p>Informe o token de acesso para entrar.</p>
          <div class="field">
            <label for="token">Token de acesso</label>
            <input class="input" id="token" type="password" required autofocus>
          </div>
          <div class="login-error" id="login-error">${esc(message)}</div>
          <button class="btn primary block" type="submit">Entrar</button>
        </form>
      </div>`;
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.submitter || $("#login-form button");
      state.token = $("#token").value.trim();
      await busy(btn, "Verificando", async () => {
        try {
          await api("ping");
          store.set(TOKEN_KEY, state.token);
          if (!location.hash) location.hash = "#/painel";
          route();
        } catch (err) {
          state.token = null;
          $("#login-error").textContent = err.message === "Token inválido." ? "Token inválido. Confira e tente novamente." : err.message;
        }
      });
    });
  }

  function logout(message) {
    state.token = null;
    store.del(TOKEN_KEY);
    renderLogin(message);
  }

  // ---------------------------------------------------------------------------
  // Estrutura e rotas
  // ---------------------------------------------------------------------------

  function renderShell() {
    if ($("#view")) return;
    const links = NAV.map(([id, label]) => `<a href="#/${id}" data-nav="${id}">${icon(id)}<span>${label}</span></a>`).join("");
    $("#app").innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          ${brand}
          <nav class="nav">${links}</nav>
          <div class="sidebar-foot">Pedro Granado Imóveis<br><button type="button" id="logout">Sair</button></div>
        </aside>
        <main class="main">
          <header class="topbar">
            <div><div class="crumb" id="crumb"></div><h1 id="page-title"></h1></div>
            <div id="topbar-tools"></div>
          </header>
          <section id="view"></section>
        </main>
        <nav class="tabbar">${links}</nav>
      </div>`;
    $("#logout").addEventListener("click", () => logout());
    $("#view").addEventListener("click", (e) => {
      const row = e.target.closest("[data-href]");
      if (row && !e.target.closest("a, button")) location.hash = row.dataset.href;
    });
  }

  function setHeader(section, title, { crumb = "", period = false } = {}) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === section));
    $("#page-title").textContent = title;
    $("#crumb").innerHTML = crumb;
    $("#topbar-tools").innerHTML = period ? periodControl() : "";
    if (period) bindPeriod();
    document.title = `${title} · Gestão de Tráfego`;
  }

  function periodControl() {
    const p = state.period;
    const opts = PRESETS.map(([v, l]) => `<option value="${v}" ${p.preset === v ? "selected" : ""}>${l}</option>`).join("");
    return `<div class="period">
      <select class="input sm" id="period-preset" aria-label="Período">${opts}</select>
      <div class="custom ${p.preset === "custom" ? "" : "hidden"}" id="period-custom">
        <input class="input sm" type="date" id="period-from" value="${p.from}" max="${todaySP()}" aria-label="Data inicial">
        <span>a</span>
        <input class="input sm" type="date" id="period-to" value="${p.to}" max="${todaySP()}" aria-label="Data final">
      </div>
    </div>`;
  }

  function bindPeriod() {
    const apply = (next) => {
      state.period = next;
      store.set(PERIOD_KEY, JSON.stringify(next));
      route();
    };
    $("#period-preset").addEventListener("change", (e) => {
      const preset = e.target.value;
      if (preset === "custom") {
        $("#period-custom").classList.remove("hidden");
        state.period = { ...state.period, preset };
        return;
      }
      const [from, to] = presetRange(preset);
      apply({ preset, from, to });
    });
    const onDate = () => {
      const from = $("#period-from").value;
      const to = $("#period-to").value;
      if (from && to && from <= to) apply({ preset: "custom", from, to });
    };
    $("#period-from").addEventListener("change", onDate);
    $("#period-to").addEventListener("change", onDate);
  }

  const periodPayload = () => ({ from: state.period.from, to: state.period.to });

  const routes = { painel: viewPainel, campanhas: viewCampanhas, campanha: viewCampanha, relatorios: viewRelatorios, telegram: viewTelegram, sistema: viewSistema };

  function route() {
    if (!state.token) return renderLogin();
    renderShell();
    destroyCharts();
    const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
    const view = routes[name] || viewPainel;
    const ticket = ++state.ticket;
    window.scrollTo(0, 0);
    view(ticket, arg ? decodeURIComponent(arg) : undefined).catch((err) => {
      if (ticket !== state.ticket || err.message === "Não autorizado.") return;
      $("#view").innerHTML = `<div class="card empty"><h3>Não foi possível carregar</h3><p>${esc(err.message)}</p><button class="btn ghost" id="retry">Tentar novamente</button></div>`;
      $("#retry").addEventListener("click", route);
    });
  }

  const stale = (ticket) => ticket !== state.ticket;

  const skeleton = () => `<div class="sk-kpis">${"<div class='skeleton'></div>".repeat(6)}</div><div class="skeleton sk-block"></div>`;

  // ---------------------------------------------------------------------------
  // Gráficos
  // ---------------------------------------------------------------------------

  function destroyCharts() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const screenPalette = () => ({ c1: cssVar("--chart-1"), c2: cssVar("--chart-2"), c3: cssVar("--chart-3"), grid: cssVar("--chart-grid"), text: cssVar("--muted") });
  const PRINT_PALETTE = { c1: "#1f3a5f", c2: "#a8844f", c3: "#5f8a7a", grid: "#ece9e2", text: "#6b6f76" };

  function dailyChartConfig(daily, pal, print = false) {
    const fontSize = print ? 22 : 12;
    const dense = daily.length > 45;
    const line = (label, key, color) => ({
      type: "line", label, data: daily.map((d) => d[key]), borderColor: color, backgroundColor: color,
      tension: 0.3, borderWidth: print ? 4 : 2, pointRadius: dense ? 0 : print ? 5 : 2.5, yAxisID: "y1", order: 1,
    });
    const datasets = [
      { type: "bar", label: "Investimento", data: daily.map((d) => d.spend), backgroundColor: pal.c1, borderRadius: 4, maxBarThickness: print ? 48 : 26, yAxisID: "y", order: 2 },
      line("Cadastros", "leads", pal.c2),
    ];
    if (daily.some((d) => d.conversations > 0)) datasets.push(line("Conversas", "conversations", pal.c3));
    return {
      data: { labels: daily.map((d) => F.d(d.date)), datasets },
      options: {
        responsive: !print, maintainAspectRatio: false, animation: print ? false : { duration: 350 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: print ? 14 : 8, color: pal.text, font: { family: FONT, size: fontSize }, padding: print ? 28 : 14 } },
          tooltip: { callbacks: { label: (ctx) => (ctx.dataset.label === "Investimento" ? ` Investimento: ${F.brl(ctx.raw)}` : ` ${ctx.dataset.label}: ${F.int(ctx.raw)}`) } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: pal.text, maxRotation: 0, autoSkipPadding: 14, font: { family: FONT, size: fontSize } } },
          y: { beginAtZero: true, grid: { color: pal.grid }, border: { display: false }, ticks: { color: pal.text, callback: (v) => F.brlShort(v), font: { family: FONT, size: fontSize } } },
          y1: { beginAtZero: true, position: "right", grid: { display: false }, border: { display: false }, ticks: { color: pal.text, precision: 0, font: { family: FONT, size: fontSize } } },
        },
      },
    };
  }

  function drawDaily(canvasId, daily) {
    const el = document.getElementById(canvasId);
    if (!el || !window.Chart) return;
    state.charts.push(new Chart(el, dailyChartConfig(daily, screenPalette())));
  }

  function drawByCampaign(canvasId, campaigns) {
    const el = document.getElementById(canvasId);
    if (!el || !window.Chart) return;
    const pal = screenPalette();
    const top = campaigns.filter((c) => c.totals.spend > 0).slice(0, 8);
    const cut = (s) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);
    state.charts.push(new Chart(el, {
      type: "bar",
      data: { labels: top.map((c) => cut(c.name)), datasets: [{ label: "Investimento", data: top.map((c) => c.totals.spend), backgroundColor: pal.c1, borderRadius: 4, maxBarThickness: 22 }] },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => top[items[0].dataIndex].name, label: (ctx) => ` ${F.brl(ctx.raw)}` } } },
        scales: {
          x: { beginAtZero: true, grid: { color: pal.grid }, border: { display: false }, ticks: { color: pal.text, callback: (v) => F.brlShort(v), font: { family: FONT } } },
          y: { grid: { display: false }, ticks: { color: pal.text, font: { family: FONT, size: 11 } } },
        },
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Blocos de interface
  // ---------------------------------------------------------------------------

  function kpiList(t, p) {
    return [
      ["Investimento", F.brl(t.spend), change(t.spend, p.spend), null],
      ["Cadastros", F.int(t.leads), change(t.leads, p.leads), false],
      ["Custo por cadastro", F.brl(t.cpl), change(t.cpl, p.cpl), true],
      ["Conversas", F.int(t.conversations), change(t.conversations, p.conversations), false],
      ["Cliques no link", F.int(t.link_clicks), change(t.link_clicks, p.link_clicks), false],
      ["CTR", F.pct(t.ctr), change(t.ctr, p.ctr), false],
    ];
  }

  function deltaInfo(d, lowerIsBetter) {
    if (d == null) return { text: "sem comparação", cls: "" };
    if (Math.abs(d) < 1) return { text: "estável", cls: "" };
    const text = `${d > 0 ? "+" : "-"}${F.pct(Math.abs(d), 0)}`;
    if (lowerIsBetter == null) return { text, cls: "" };
    const good = lowerIsBetter ? d < 0 : d > 0;
    return { text, cls: good ? "good" : "bad" };
  }

  function kpis(t, p) {
    return `<div class="kpis">${kpiList(t, p).map(([label, value, d, lower]) => {
      const info = deltaInfo(d, lower);
      return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value" title="${esc(value)}">${value}</div><div class="delta ${info.cls}">${info.text}${d != null ? " vs. anterior" : ""}</div></div>`;
    }).join("")}</div>`;
  }

  function campaignTable(list, { withMeta = true } = {}) {
    if (!list.length) return `<div class="empty">Nenhuma campanha encontrada.</div>`;
    const rows = list.map((c) => {
      const t = c.totals;
      return `<tr class="link" data-href="#/campanha/${esc(c.id)}">
        <td><div class="camp-name">${esc(c.name)}</div>${withMeta ? `<div class="camp-meta">${statusPill(c.effective_status)}<span>${esc(objective(c.objective))}</span><span>${esc(budget(c))}</span></div>` : ""}</td>
        <td data-label="Investimento">${F.brl(t.spend)}</td>
        <td data-label="Cadastros">${F.int(t.leads)}</td>
        <td data-label="Custo/cadastro">${F.brl(t.cpl)}</td>
        <td data-label="Conversas">${F.int(t.conversations)}</td>
        <td data-label="Cliques">${F.int(t.link_clicks)}</td>
        <td data-label="CTR">${F.pct(t.ctr)}</td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table class="data cards">
      <thead><tr><th>Campanha</th><th>Investimento</th><th>Cadastros</th><th>Custo/cadastro</th><th>Conversas</th><th>Cliques</th><th>CTR</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function syncLine(run) {
    if (!run) return "Nenhuma sincronização registrada ainda.";
    const status = run.status === "erro" ? " · falhou" : run.status === "executando" ? " · em andamento" : "";
    return `Dados sincronizados com a Meta em ${F.dt(run.finished_at || run.started_at)}${status}`;
  }

  function syncBar(run) {
    return `<div class="syncbar"><span>${syncLine(run)}</span><button class="btn ghost sm" id="sync-now">${icon("refresh")}Atualizar dados</button></div>`;
  }

  function bindSync(days = 3) {
    const btn = $("#sync-now");
    if (!btn) return;
    btn.addEventListener("click", () => busy(btn, "Atualizando", async () => {
      try {
        await api("sync", { days });
        toast("Dados atualizados.");
        route();
      } catch (e) { toast(e.message, "error"); }
    }));
  }

  const noData = () => `<div class="card empty"><h3>Ainda não há dados</h3><p>Importe o histórico de campanhas para começar.</p><a class="btn primary" href="#/sistema">Ir para Sistema</a></div>`;

  // ---------------------------------------------------------------------------
  // Painel
  // ---------------------------------------------------------------------------

  async function viewPainel(ticket) {
    setHeader("painel", "Painel", { period: true, crumb: range(state.period.from, state.period.to) });
    $("#view").innerHTML = skeleton();
    const s = await api("summary", periodPayload());
    if (stale(ticket)) return;
    if (!s.accounts.length) { $("#view").innerHTML = noData(); return; }

    const active = s.campaigns.filter((c) => c.effective_status === "ACTIVE");
    $("#view").innerHTML = `
      ${syncBar(s.lastSync)}
      ${kpis(s.totals, s.previous)}
      <div class="grid-2">
        <div class="card"><div class="card-head"><h3>Evolução diária</h3></div><div class="chart-box"><canvas id="ch-daily"></canvas></div></div>
        <div class="card"><div class="card-head"><h3>Investimento por campanha</h3></div><div class="chart-box"><canvas id="ch-camp"></canvas></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Campanhas ativas<span class="count">${active.length}</span></h3><a href="#/campanhas">Ver todas</a></div>
        ${campaignTable(active)}
      </div>`;
    drawDaily("ch-daily", s.daily);
    drawByCampaign("ch-camp", s.campaigns);
    bindSync();
  }

  // ---------------------------------------------------------------------------
  // Campanhas
  // ---------------------------------------------------------------------------

  let campaignFilter = { status: "ativas", q: "" };

  async function viewCampanhas(ticket) {
    setHeader("campanhas", "Campanhas", { period: true, crumb: range(state.period.from, state.period.to) });
    $("#view").innerHTML = `<div class="skeleton sk-block" style="margin-top:0"></div>`;
    const s = await api("summary", periodPayload());
    if (stale(ticket)) return;
    if (!s.accounts.length) { $("#view").innerHTML = noData(); return; }

    const filters = [["ativas", "Ativas"], ["pausadas", "Pausadas"], ["com-entrega", "Com entrega no período"], ["todas", "Todas"]];
    $("#view").innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="chips">${filters.map(([v, l]) => `<button class="chip" data-filter="${v}">${l}</button>`).join("")}</div>
          <input class="input sm" id="camp-q" type="search" placeholder="Buscar campanha" value="${esc(campaignFilter.q)}" style="min-width:220px">
        </div>
        <div id="camp-list"></div>
      </div>`;

    const paint = () => {
      const q = campaignFilter.q.toLowerCase();
      const list = s.campaigns.filter((c) => {
        const st = c.effective_status;
        if (campaignFilter.status === "ativas" && st !== "ACTIVE") return false;
        if (campaignFilter.status === "pausadas" && !["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(st)) return false;
        if (campaignFilter.status === "com-entrega" && !(c.totals.spend > 0)) return false;
        return !q || c.name.toLowerCase().includes(q);
      });
      $$("[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === campaignFilter.status));
      $("#camp-list").innerHTML = campaignTable(list);
    };
    $$("[data-filter]").forEach((b) => b.addEventListener("click", () => { campaignFilter.status = b.dataset.filter; paint(); }));
    $("#camp-q").addEventListener("input", (e) => { campaignFilter.q = e.target.value; paint(); });
    paint();
  }

  // ---------------------------------------------------------------------------
  // Campanha
  // ---------------------------------------------------------------------------

  async function viewCampanha(ticket, id) {
    setHeader("campanhas", "Campanha", { period: true, crumb: `<a href="#/campanhas">Campanhas</a>` });
    $("#view").innerHTML = skeleton();
    const s = await api("summary", { ...periodPayload(), campaign_ids: [id] });
    if (stale(ticket)) return;
    const c = s.campaigns[0];
    if (!c) { $("#view").innerHTML = `<div class="card empty"><h3>Campanha não encontrada</h3></div>`; return; }

    $("#page-title").textContent = c.name;
    document.title = `${c.name} · Gestão de Tráfego`;
    const days = [...s.daily].reverse().filter((d) => d.spend > 0 || d.impressions > 0);
    const dates = [c.start_time && `Início ${F.dt(c.start_time).slice(0, 10)}`, c.stop_time && `Término ${F.dt(c.stop_time).slice(0, 10)}`].filter(Boolean).join(" · ");

    $("#view").innerHTML = `
      <div class="card">
        <div class="card-head" style="margin-bottom:0">
          <div class="camp-meta" style="margin:0">${statusPill(c.effective_status)}<span>${esc(objective(c.objective))}</span><span>${esc(budget(c))}</span>${dates ? `<span>${esc(dates)}</span>` : ""}</div>
          <div class="chips">
            <a class="btn ghost sm" href="#/relatorios/${esc(c.id)}">${icon("download")}Relatório em PDF</a>
            <a class="btn ghost sm" href="#/telegram/${esc(c.id)}">${icon("send")}Enviar análise</a>
          </div>
        </div>
      </div>
      ${kpis(s.totals, s.previous).replace('class="kpis"', 'class="kpis" style="margin-top:18px"')}
      <div class="card"><div class="card-head"><h3>Evolução diária</h3><span class="muted" style="font-size:13px">${range(s.period.from, s.period.to)}</span></div><div class="chart-box"><canvas id="ch-daily"></canvas></div></div>
      <div class="card">
        <div class="card-head"><h3>Dia a dia</h3></div>
        ${days.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Data</th><th>Investimento</th><th>Impressões</th><th>Cliques</th><th>CTR</th><th>Cadastros</th><th>Custo/cadastro</th><th>Conversas</th></tr></thead>
          <tbody>${days.map((d) => `<tr><td>${F.date(d.date)}</td><td>${F.brl(d.spend)}</td><td>${F.int(d.impressions)}</td><td>${F.int(d.link_clicks)}</td><td>${F.pct(d.ctr)}</td><td>${F.int(d.leads)}</td><td>${F.brl(d.cpl)}</td><td>${F.int(d.conversations)}</td></tr>`).join("")}</tbody>
        </table></div>` : `<div class="empty">Sem entrega no período.</div>`}
      </div>`;
    drawDaily("ch-daily", s.daily);
  }

  // ---------------------------------------------------------------------------
  // Seleção de campanha e período (Relatórios e Telegram)
  // ---------------------------------------------------------------------------

  async function selectionForm(prefix, selectedId, allLabel) {
    const { campaigns } = await api("campaigns");
    const sorted = [...campaigns].sort(byActiveThenName);
    const options = sorted.map((c) => `<option value="${esc(c.id)}" ${c.id === selectedId ? "selected" : ""}>${esc(c.name)}${c.effective_status === "ACTIVE" ? "" : ` (${esc((STATUS[c.effective_status] || [c.effective_status || "inativa"])[0].toLowerCase())})`}</option>`).join("");
    return {
      campaigns,
      html: `
        <div class="field"><label for="${prefix}-camp">Campanha</label>
          <select class="input" id="${prefix}-camp"><option value="">${allLabel}</option>${options}</select></div>
        <div class="field"><label for="${prefix}-from">De</label><input class="input" type="date" id="${prefix}-from" value="${state.period.from}" max="${todaySP()}"></div>
        <div class="field"><label for="${prefix}-to">Até</label><input class="input" type="date" id="${prefix}-to" value="${state.period.to}" max="${todaySP()}"></div>`,
    };
  }

  function readSelection(prefix) {
    const id = $(`#${prefix}-camp`).value;
    const from = $(`#${prefix}-from`).value;
    const to = $(`#${prefix}-to`).value;
    if (!from || !to) throw new Error("Informe o período.");
    if (from > to) throw new Error("A data inicial é posterior à data final.");
    return { id, from, to, campaign_ids: id ? [id] : null };
  }

  // ---------------------------------------------------------------------------
  // Relatórios
  // ---------------------------------------------------------------------------

  async function viewRelatorios(ticket, preselect) {
    setHeader("relatorios", "Relatórios");
    $("#view").innerHTML = `<div class="skeleton sk-block" style="margin-top:0"></div>`;
    const [form, history] = await Promise.all([selectionForm("rp", preselect, "Todas as campanhas"), api("reports")]);
    if (stale(ticket)) return;

    $("#view").innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Novo relatório</h3></div>
        <div class="form-grid">
          ${form.html}
          <button class="btn primary" id="rp-go">${icon("download")}Gerar PDF</button>
        </div>
        <p class="muted" style="font-size:13px;margin:12px 0 0">O PDF é baixado e fica guardado no histórico abaixo.</p>
      </div>
      <div class="card">
        <div class="card-head"><h3>Histórico<span class="count">${history.reports.length}</span></h3></div>
        <div class="list" id="rp-history">${reportList(history.reports)}</div>
      </div>`;

    $("#rp-go").addEventListener("click", (e) => busy(e.currentTarget, "Gerando", async () => {
      try {
        const sel = readSelection("rp");
        const campaign = form.campaigns.find((c) => c.id === sel.id) || null;
        await generateReport(sel, campaign);
        const fresh = await api("reports");
        if (!stale(ticket)) $("#rp-history").innerHTML = reportList(fresh.reports);
      } catch (err) { toast(err.message, "error"); }
    }));
  }

  function reportList(reports) {
    if (!reports.length) return `<div class="empty">Nenhum relatório gerado ainda.</div>`;
    return reports.map((r) => `
      <div class="list-item">
        <div><div class="title">${esc(r.title)}</div><div class="sub">${range(r.date_from, r.date_to)} · gerado em ${F.dt(r.created_at)}${r.file_size ? ` · ${F.bytes(r.file_size)}` : ""}</div></div>
        ${r.url ? `<a class="btn ghost sm" href="${esc(r.url)}" target="_blank" rel="noopener">${icon("download")}Baixar</a>` : ""}
      </div>`).join("");
  }

  async function generateReport(sel, campaign) {
    const [summary, analysis] = await Promise.all([
      api("summary", { from: sel.from, to: sel.to, campaign_ids: sel.campaign_ids }),
      api("analysis", { from: sel.from, to: sel.to, campaign_ids: sel.campaign_ids }),
    ]);
    const title = campaign ? campaign.name : "Todas as campanhas";
    const doc = await buildPdf({ summary, analysis: analysis.analysis, title, campaign });
    const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    doc.save(`relatorio-${slug}-${sel.from}-a-${sel.to}.pdf`);

    const pdf_base64 = doc.output("datauristring").split(",")[1];
    await api("report_save", { title, campaign_ids: sel.campaign_ids, from: sel.from, to: sel.to, pdf_base64, summary: { totals: summary.totals, previous: summary.previous } });
    toast("Relatório gerado e guardado no histórico.");
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  // Fontes padrão do PDF cobrem o alfabeto latino; outros símbolos são simplificados.
  const pdfText = (s) => String(s ?? "")
    .replace(/[–—−]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, "...").replace(/[^\x00-\xff]/g, "").trim();

  async function chartImage(daily) {
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-10000px;top:0;width:1800px;height:720px";
    const canvas = document.createElement("canvas");
    canvas.width = 1800;
    canvas.height = 720;
    holder.appendChild(canvas);
    document.body.appendChild(holder);
    const cfg = dailyChartConfig(daily, PRINT_PALETTE, true);
    cfg.options.devicePixelRatio = 1;
    // Fundo branco para exportar em JPEG, bem mais leve que PNG dentro do PDF.
    cfg.plugins = [{ id: "fundo", beforeDraw: (c) => { c.ctx.save(); c.ctx.fillStyle = "#ffffff"; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore(); } }];
    const chart = new Chart(canvas, cfg);
    const img = chart.toBase64Image("image/jpeg", 0.9);
    chart.destroy();
    holder.remove();
    return img;
  }

  async function buildPdf({ summary, analysis, title, campaign }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = 210, H = 297, M = 16;
    const NAVY = [31, 58, 95], BRONZE = [168, 132, 79], INK = [27, 30, 35], MUTED = [110, 115, 122], LINE = [226, 222, 214], SOFT = [250, 249, 246];
    const GOOD = [46, 122, 87], BAD = [176, 68, 44];
    let y = 0;

    const ensure = (space) => { if (y + space > H - 18) { doc.addPage(); y = 20; } };
    const heading = (text, space = 16) => {
      ensure(space);
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...NAVY);
      doc.text(pdfText(text).toUpperCase(), M, y, { charSpace: 0.3 });
      doc.setDrawColor(...BRONZE); doc.setLineWidth(0.5); doc.line(M, y + 2, M + 14, y + 2);
      y += 9;
    };

    // Cabeçalho
    doc.setFillColor(...NAVY); doc.rect(0, 0, W, 32, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.text("PEDRO GRANADO IMÓVEIS", M, 12, { charSpace: 0.8 });
    doc.setFontSize(16); doc.text("Relatório de desempenho · Meta Ads", M, 22);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.text(`Gerado em ${F.dt(new Date())}`, W - M, 12, { align: "right" });
    doc.setFillColor(...BRONZE); doc.rect(0, 32, W, 1.2, "F");
    y = 46;

    // Título e contexto
    doc.setTextColor(...INK); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    const titleLines = doc.splitTextToSize(pdfText(title), W - 2 * M);
    doc.text(titleLines, M, y); y += titleLines.length * 6.4;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
    const context = [];
    if (campaign) {
      context.push([(STATUS[campaign.effective_status] || [campaign.effective_status || ""])[0], objective(campaign.objective), budget(campaign)].filter(Boolean).join(" · "));
    }
    context.push(`Período: ${range(summary.period.from, summary.period.to)} · Comparação: ${range(summary.previousPeriod.from, summary.previousPeriod.to)}`);
    context.forEach((line) => { doc.text(pdfText(line), M, y); y += 5; });
    y += 5;

    // Indicadores
    const list = kpiList(summary.totals, summary.previous);
    const gap = 4, bw = (W - 2 * M - 2 * gap) / 3, bh = 22;
    list.forEach(([label, value, d, lower], i) => {
      const x = M + (i % 3) * (bw + gap);
      const yy = y + Math.floor(i / 3) * (bh + gap);
      doc.setFillColor(...SOFT); doc.setDrawColor(...LINE); doc.setLineWidth(0.25);
      doc.roundedRect(x, yy, bw, bh, 2, 2, "FD");
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
      doc.text(pdfText(label).toUpperCase(), x + 4, yy + 6.5, { charSpace: 0.2 });
      doc.setFontSize(14); doc.setTextColor(...INK); doc.text(pdfText(value), x + 4, yy + 14);
      const info = deltaInfo(d, lower);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
      doc.setTextColor(...(info.cls === "good" ? GOOD : info.cls === "bad" ? BAD : MUTED));
      doc.text(pdfText(`${info.text}${d != null ? " vs. período anterior" : ""}`), x + 4, yy + 19);
    });
    y += 2 * (bh + gap) + 6;

    // Gráfico
    const chartH = (W - 2 * M) * (720 / 1800);
    heading("Evolução diária", chartH + 14);
    doc.addImage(await chartImage(summary.daily), "JPEG", M, y, W - 2 * M, chartH);
    y += chartH + 8;

    // Leitura do período
    const bullets = (items, color) => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
      items.forEach((item) => {
        const lines = doc.splitTextToSize(pdfText(item), W - 2 * M - 6);
        ensure(lines.length * 4.8 + 2);
        doc.setFillColor(...color); doc.circle(M + 1.2, y - 1.2, 0.9, "F");
        doc.setTextColor(...INK); doc.text(lines, M + 5, y);
        y += lines.length * 4.8 + 1.8;
      });
    };
    heading("Leitura do período");
    if (analysis.highlights.length) bullets(analysis.highlights, GOOD);
    if (analysis.alerts.length) bullets(analysis.alerts, BAD);
    if (!analysis.highlights.length && !analysis.alerts.length) bullets(["Sem destaques ou pontos de atenção para o período."], MUTED);
    y += 4;

    const tableBase = {
      theme: "plain",
      margin: { left: M, right: M, top: 20, bottom: 20 },
      styles: { font: "helvetica", fontSize: 8.3, textColor: INK, cellPadding: { top: 2.2, bottom: 2.2, left: 1.5, right: 1.5 }, lineColor: LINE, lineWidth: { bottom: 0.2 } },
      headStyles: { fontStyle: "bold", textColor: MUTED, fontSize: 7.3, lineWidth: { bottom: 0.4 }, lineColor: NAVY },
    };

    // Por campanha
    const withSpend = summary.campaigns.filter((c) => c.totals.spend > 0);
    if (withSpend.length > 1) {
      heading("Por campanha", 40);
      doc.autoTable({
        ...tableBase, startY: y,
        head: [["CAMPANHA", "INVESTIMENTO", "CADASTROS", "CUSTO/CAD.", "CONVERSAS", "CLIQUES", "CTR"]],
        body: withSpend.map((c) => [pdfText(c.name), F.brl(c.totals.spend), F.int(c.totals.leads), F.brl(c.totals.cpl), F.int(c.totals.conversations), F.int(c.totals.link_clicks), F.pct(c.totals.ctr)].map(pdfText)),
        columnStyles: { 0: { cellWidth: 58 }, 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
        didParseCell: (d) => { if (d.section === "head" && d.column.index > 0) d.cell.styles.halign = "right"; },
      });
      y = doc.lastAutoTable.finalY + 10;
    }

    // Dia a dia
    const days = summary.daily.filter((d) => d.spend > 0 || d.impressions > 0);
    if (days.length) {
      heading("Dia a dia", 40);
      doc.autoTable({
        ...tableBase, startY: y,
        head: [["DATA", "INVESTIMENTO", "IMPRESSÕES", "CLIQUES", "CTR", "CADASTROS", "CUSTO/CAD.", "CONVERSAS"].map(pdfText)],
        body: days.map((d) => [F.date(d.date), F.brl(d.spend), F.int(d.impressions), F.int(d.link_clicks), F.pct(d.ctr), F.int(d.leads), F.brl(d.cpl), F.int(d.conversations)].map(pdfText)),
        columnStyles: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [i, { halign: "right" }])),
        didParseCell: (d) => { if (d.section === "head" && d.column.index > 0) d.cell.styles.halign = "right"; },
      });
    }

    // Rodapé
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(M, H - 12, W - M, H - 12);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
      doc.text("Pedro Granado Imóveis · Gestão de Tráfego · Dados: Meta Ads", M, H - 7);
      doc.text(`${i} de ${pages}`, W - M, H - 7, { align: "right" });
    }
    return doc;
  }

  // ---------------------------------------------------------------------------
  // Telegram
  // ---------------------------------------------------------------------------

  async function viewTelegram(ticket, preselect) {
    setHeader("telegram", "Telegram");
    $("#view").innerHTML = `<div class="skeleton sk-block" style="margin-top:0"></div>`;
    const [form, history] = await Promise.all([selectionForm("tg", preselect, "Todas as campanhas ativas"), api("telegram_history")]);
    if (stale(ticket)) return;

    $("#view").innerHTML = `
      <div class="grid-2 even">
        <div class="card">
          <div class="card-head"><h3>Enviar análise</h3></div>
          <div class="form-grid" style="grid-template-columns:1fr 1fr">
            ${form.html.replace('<div class="field"><label for="tg-camp">', '<div class="field" style="grid-column:1/-1"><label for="tg-camp">')}
          </div>
          <label style="display:flex;gap:8px;align-items:center;margin:14px 0 16px;font-size:14px"><input type="checkbox" id="tg-compare" checked> Comparar com o período anterior</label>
          <div class="chips">
            <button class="btn ghost" id="tg-preview">Pré-visualizar</button>
            <button class="btn primary" id="tg-send">${icon("send")}Enviar ao Telegram</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Pré-visualização</h3></div>
          <div class="tg-preview" id="tg-output"><span class="muted">Escolha a campanha e o período e clique em Pré-visualizar.</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Envios automáticos</h3></div>
        <div class="list">
          <div class="list-item"><div><div class="title">06h00 · Fechamento de ontem</div><div class="sub">Campanhas ativas, comparadas ao dia anterior</div></div></div>
          <div class="list-item"><div><div class="title">19h00 · Parcial de hoje</div><div class="sub">Resultados do dia até o momento do envio</div></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Histórico de envios<span class="count">${history.messages.length}</span></h3></div>
        <div class="list" id="tg-history">${telegramList(history.messages)}</div>
      </div>`;

    const params = () => ({ ...readSelection("tg"), compare: $("#tg-compare").checked });
    $("#tg-preview").addEventListener("click", (e) => busy(e.currentTarget, "Montando", async () => {
      try {
        const p = params();
        const r = await api("analysis", { from: p.from, to: p.to, campaign_ids: p.campaign_ids, compare: p.compare });
        $("#tg-output").innerHTML = r.text; // texto gerado pelo servidor, com nomes já escapados
      } catch (err) { toast(err.message, "error"); }
    }));
    $("#tg-send").addEventListener("click", (e) => busy(e.currentTarget, "Enviando", async () => {
      try {
        const p = params();
        const r = await api("telegram_send", { from: p.from, to: p.to, campaign_ids: p.campaign_ids, compare: p.compare });
        $("#tg-output").innerHTML = r.text;
        toast("Análise enviada ao Telegram.");
      } catch (err) { toast(err.message, "error"); }
      const fresh = await api("telegram_history").catch(() => null);
      if (fresh && !stale(ticket)) $("#tg-history").innerHTML = telegramList(fresh.messages);
    }));
  }

  function telegramList(messages) {
    if (!messages.length) return `<div class="empty">Nenhum envio registrado ainda.</div>`;
    return messages.map((m) => `
      <details class="tg list-item" style="display:block">
        <summary>
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <div><div class="title">${F.dt(m.created_at)}</div><div class="sub">${m.date_from ? range(m.date_from, m.date_to) : ""}${m.error ? ` · ${esc(m.error)}` : ""}</div></div>
            <div class="chips"><span class="pill">${m.origin === "agendado" ? "Agendado" : "Manual"}</span><span class="pill ${m.status === "enviado" ? "active" : "error"}">${m.status === "enviado" ? "Enviado" : "Falhou"}</span></div>
          </div>
        </summary>
        <div class="tg-preview">${m.text}</div>
      </details>`).join("");
  }

  // ---------------------------------------------------------------------------
  // Sistema
  // ---------------------------------------------------------------------------

  async function viewSistema(ticket) {
    setHeader("sistema", "Sistema");
    $("#view").innerHTML = `<div class="skeleton sk-block" style="margin-top:0"></div>`;
    const s = await api("system");
    if (stale(ticket)) return;
    const c = s.counts;
    const duration = (r) => (r.finished_at ? `${Math.max(1, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000))} s` : "–");
    const runStatus = { concluido: ["Concluída", "active"], erro: ["Falhou", "error"], executando: ["Em andamento", "paused"] };

    $("#view").innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Base de dados</h3></div>
        <div class="info-grid">
          <div class="info"><div class="k">Campanhas</div><div class="v">${F.int(c.campaigns)}</div></div>
          <div class="info"><div class="k">Registros diários</div><div class="v">${F.int(c.campaign_insights_daily)}</div></div>
          <div class="info"><div class="k">Relatórios</div><div class="v">${F.int(c.reports)}</div></div>
          <div class="info"><div class="k">Envios ao Telegram</div><div class="v">${F.int(c.telegram_messages)}</div></div>
        </div>
      </div>
      <div class="grid-2 even">
        <div class="card">
          <div class="card-head"><h3>Sincronização com a Meta</h3></div>
          <p class="muted" style="margin:0 0 14px;font-size:14px">Os dados são atualizados automaticamente a cada hora. Use a importação de histórico na primeira configuração.</p>
          <div class="chips">
            <button class="btn primary" data-sync="7">${icon("refresh")}Atualizar últimos 7 dias</button>
            <button class="btn ghost" data-sync="90">Importar histórico de 90 dias</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Contas de anúncio</h3></div>
          <div class="list">${s.accounts.length ? s.accounts.map((a) => `<div class="list-item"><div><div class="title">${esc(a.name || a.id)}</div><div class="sub">${esc(a.id)} · ${esc(a.currency || "")} · ${esc(a.timezone || "")}</div></div></div>`).join("") : `<div class="empty">Nenhuma conta sincronizada ainda.</div>`}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Últimas sincronizações</h3></div>
        ${s.runs.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Início</th><th>Origem</th><th>Dias</th><th>Duração</th><th>Situação</th></tr></thead>
          <tbody>${s.runs.map((r) => { const [label, cls] = runStatus[r.status] || [r.status, ""]; return `<tr><td>${F.dt(r.started_at)}${r.error ? `<div class="sub muted" style="white-space:normal;font-size:12px">${esc(r.error)}</div>` : ""}</td><td>${r.origin === "agendado" ? "Agendada" : "Manual"}</td><td>${r.days ?? "–"}</td><td>${duration(r)}</td><td><span class="pill ${cls}">${esc(label)}</span></td></tr>`; }).join("")}</tbody>
        </table></div>` : `<div class="empty">Nenhuma sincronização registrada.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h3>Sessão</h3></div>
        <p class="muted" style="margin:0 0 14px;font-size:14px">O acesso fica salvo neste aparelho até você sair.</p>
        <button class="btn ghost" id="logout-2">Sair deste aparelho</button>
      </div>`;

    $$("[data-sync]").forEach((btn) => btn.addEventListener("click", () => busy(btn, "Sincronizando", async () => {
      try {
        const r = await api("sync", { days: Number(btn.dataset.sync) });
        const rows = (r.details || []).reduce((n, d) => n + (d.insight_rows || 0), 0);
        toast(`Sincronização concluída: ${F.int(rows)} registros diários.`);
        route();
      } catch (err) { toast(err.message, "error"); route(); }
    })));
    $("#logout-2").addEventListener("click", () => logout());
  }

  // ---------------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------------

  if (window.Chart) {
    Chart.defaults.font.family = FONT;
  }
  window.addEventListener("hashchange", route);
  if (!CFG.API_URL || CFG.API_URL.includes("SEU-PROJETO")) {
    $("#app").innerHTML = `<div class="login"><div class="login-card">${brand}<p>Configure o endereço da API em <strong>assets/config.js</strong> para usar o sistema.</p></div></div>`;
  } else {
    route();
  }
})();
