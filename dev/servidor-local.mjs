// Servidor local para testar a interface sem Supabase, Meta ou Telegram.
// Usa a mesma lógica da Edge Function (app.ts / core.ts) com dados fictícios em memória.
// Uso: node dev/servidor-local.mjs  ->  http://localhost:8787  (token: o APP_TOKEN de supabase/.env, ou "teste-local" se o arquivo não existir)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApi } from "../supabase/functions/api/app.ts";
import { addDays, todaySP } from "../supabase/functions/api/core.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT || 8787);

function readEnvToken() {
  const file = join(ROOT, "supabase", ".env");
  if (!existsSync(file)) return "teste-local";
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("APP_TOKEN="));
  return line?.slice("APP_TOKEN=".length).trim() || "teste-local";
}
const TOKEN = readEnvToken();

// ---------------------------------------------------------------------------
// Dados fictícios
// ---------------------------------------------------------------------------

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const ACCOUNT = { id: "act_000000000000001", name: "Conta de testes", currency: "BRL", timezone: "America/Sao_Paulo", updated_at: new Date().toISOString() };
const today = todaySP();

const CAMPAIGNS = [
  ["120200000000000001", "Teste · Cadastros alto padrão", "OUTCOME_LEADS", "ACTIVE", 180, 12, 0.012],
  ["120200000000000002", "Teste · Mensagens WhatsApp", "OUTCOME_ENGAGEMENT", "ACTIVE", 120, 0, 0.016],
  ["120200000000000003", "Teste · Tráfego portfólio de venda", "OUTCOME_TRAFFIC", "ACTIVE", 80, 0, 0.021],
  ["120200000000000004", "Teste · Remarketing visitantes", "OUTCOME_LEADS", "ACTIVE", 60, 5, 0.006],
  ["120200000000000005", "Teste · Locação apartamentos", "OUTCOME_LEADS", "ACTIVE", 90, 9, 0.014],
  ["120200000000000006", "Teste · Institucional", "OUTCOME_AWARENESS", "ACTIVE", 0, 0, 0.004],
  ["120200000000000007", "Teste · Campanha pausada", "OUTCOME_LEADS", "PAUSED", 100, 7, 0.011],
].map(([id, name, objective, status, daily, leadsPerDay, ctr]) => ({
  id, account_id: ACCOUNT.id, name, objective, status, effective_status: status,
  daily_budget: daily || null, lifetime_budget: null,
  start_time: `${addDays(today, -150)}T09:00:00-0300`,
  stop_time: id.endsWith("5") ? `${addDays(today, 2)}T23:59:00-0300` : null,
  _gen: { daily, leadsPerDay, ctr },
}));

const DAILY = [];
for (let i = 120; i >= 0; i--) {
  const date = addDays(today, -i);
  for (const c of CAMPAIGNS) {
    const g = c._gen;
    if (!g.daily) continue;
    if (c.status === "PAUSED" && i < 20) continue;
    const partial = i === 0 ? 0.6 : 1;
    const spend = g.daily * (0.75 + rand() * 0.45) * partial;
    const impressions = Math.round(spend * (55 + rand() * 30));
    const link = Math.round(impressions * g.ctr * (0.7 + rand() * 0.6));
    const leads = g.leadsPerDay ? Math.round(g.leadsPerDay * (0.5 + rand()) * partial * (i < 7 && c.id.endsWith("4") ? 0.45 : 1)) : 0;
    const conversations = c.objective === "OUTCOME_ENGAGEMENT" ? Math.round((8 + rand() * 8) * partial) : 0;
    DAILY.push({ campaign_id: c.id, date, spend: Math.round(spend * 100) / 100, impressions, reach: Math.round(impressions * 0.7), clicks: Math.round(link * 1.4), link_clicks: link, leads, conversations });
  }
}

const REPORTS = [];
const FILES = new Map();
const MESSAGES = [];
const RUNS = [{ id: 1, origin: "agendado", days: 3, status: "concluido", details: [], error: null, started_at: new Date(Date.now() - 36e5).toISOString(), finished_at: new Date(Date.now() - 36e5 + 8000).toISOString() }];

const store = {
  async listCampaigns() { return CAMPAIGNS.map(({ _gen, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name)); },
  async listDaily(from, to, ids) { return DAILY.filter((r) => r.date >= from && r.date <= to && (!ids || ids.includes(r.campaign_id))); },
  async listAccounts() { return [ACCOUNT]; },
  async listSyncRuns(limit) { return RUNS.slice(0, limit); },
  async counts() { return { campaigns: CAMPAIGNS.length, campaign_insights_daily: DAILY.length, reports: REPORTS.length, telegram_messages: MESSAGES.length }; },
  async sync(days, origin) {
    await new Promise((r) => setTimeout(r, 900));
    const run = { id: RUNS.length + 1, origin, days, status: "concluido", details: [{ account: ACCOUNT.id, campaigns: CAMPAIGNS.length, insight_rows: days * 6 }], error: null, started_at: new Date(Date.now() - 900).toISOString(), finished_at: new Date().toISOString() };
    RUNS.unshift(run);
    return { ok: true, details: run.details };
  },
  async saveReport(row, pdf) {
    const id = randomUUID();
    FILES.set(id, pdf);
    const saved = { id, ...row, file_path: `${id}.pdf`, created_at: new Date().toISOString() };
    REPORTS.unshift(saved);
    return saved;
  },
  async listReports(limit) { return REPORTS.slice(0, limit).map((r) => ({ ...r, url: `/dev-files/${r.id}.pdf` })); },
  async sendTelegram(text) { console.log("\n[Telegram simulado]\n" + text + "\n"); },
  async logTelegram(row) { const saved = { id: randomUUID(), ...row, created_at: new Date().toISOString() }; MESSAGES.unshift(saved); return saved; },
  async listTelegram(limit) { return MESSAGES.slice(0, limit); },
};

const api = createApi(store);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json" };

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (body.action === "cron") return send(res, 200, await api.cron(body.kind));
      if (req.headers["x-app-token"] !== TOKEN) {
        await new Promise((r) => setTimeout(r, 400));
        return send(res, 401, { error: "Token inválido." });
      }
      try {
        return send(res, 200, await api.handle(body.action, body));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }
    if (url.pathname === "/assets/config.js") {
      return send(res, 200, 'window.APP_CONFIG = { API_URL: "/api" };', TYPES[".js"]);
    }
    if (url.pathname.startsWith("/dev-files/")) {
      const pdf = FILES.get(url.pathname.slice(11).replace(/\.pdf$/, ""));
      return pdf ? send(res, 200, Buffer.from(pdf), "application/pdf") : send(res, 404, "Não encontrado", "text/plain");
    }
    const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^([/\\])+/, "");
    if (rel.startsWith("..") || rel.startsWith("supabase") || rel.startsWith("dev")) return send(res, 404, "Não encontrado", "text/plain");
    const file = join(ROOT, rel);
    if (!existsSync(file)) return send(res, 404, "Não encontrado", "text/plain");
    return send(res, 200, await readFile(file), TYPES[extname(file)] || "application/octet-stream");
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Servidor local em http://localhost:${PORT}`));
