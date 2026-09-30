// Edge Function "api": porta única do sistema.
// Valida o token de acesso, consulta o banco, sincroniza com a Meta e envia ao Telegram.
// Tokens da Meta e do Telegram ficam apenas aqui, como secrets do Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";
import { createApi } from "./app.ts";
import type { Store } from "./app.ts";
import { addDays, CONVERSATION_ACTIONS, LEAD_ACTIONS, pickAction, todaySP } from "./core.ts";
import type { Campaign, Daily } from "./core.ts";

const env = (key: string, fallback = "") => Deno.env.get(key)?.trim() || fallback;

const APP_TOKEN = env("APP_TOKEN");
const CRON_SECRET = env("CRON_SECRET");
const META_TOKEN = env("META_ACCESS_TOKEN");
const META_VERSION = env("META_API_VERSION", "v23.0");
const META_ACCOUNTS = env("META_AD_ACCOUNT_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((id) => (id.startsWith("act_") ? id : `act_${id}`));
const TELEGRAM_TOKEN = env("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT = env("TELEGRAM_CHAT_ID");
const BUCKET = "relatorios";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-token, x-cron-secret, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

// ---------------------------------------------------------------------------
// Meta Graph API
// ---------------------------------------------------------------------------

async function metaFetch(url: string) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.error) return body;
    const retryable = res.status >= 500 || body.error?.code === 4 || body.error?.code === 17;
    if (retryable && attempt < 3) {
      await sleep(3000 * attempt);
      continue;
    }
    throw new Error(`Meta: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }
}

async function metaList(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, access_token: META_TOKEN, limit: "500" });
  let url: string | null = `https://graph.facebook.com/${META_VERSION}/${path}?${qs}`;
  const out: any[] = [];
  while (url) {
    const page = await metaFetch(url);
    out.push(...(page.data ?? []));
    url = page.paging?.next ?? null;
  }
  return out;
}

function metaObject(path: string, fields: string) {
  const qs = new URLSearchParams({ fields, access_token: META_TOKEN });
  return metaFetch(`https://graph.facebook.com/${META_VERSION}/${path}?${qs}`);
}

async function upsert(table: string, rows: unknown[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    check(await db.from(table).upsert(rows.slice(i, i + 500), { onConflict }));
  }
}

async function syncFromMeta(days: number, origin: string) {
  if (!META_TOKEN || !META_ACCOUNTS.length) throw new Error("Configure META_ACCESS_TOKEN e META_AD_ACCOUNT_IDS nos secrets do Supabase.");
  const run = check(await db.from("sync_runs").insert({ origin, days, status: "executando" }).select("id").single());
  const until = todaySP();
  const since = addDays(until, -(days - 1));
  const details: unknown[] = [];

  try {
    for (const account of META_ACCOUNTS) {
      const info = await metaObject(account, "name,currency,timezone_name");
      const now = new Date().toISOString();
      await upsert("ad_accounts", [{ id: account, name: info.name, currency: info.currency, timezone: info.timezone_name, updated_at: now }], "id");

      const campaigns = await metaList(`${account}/campaigns`, {
        fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time",
      });
      const known = new Set(campaigns.map((c) => c.id));
      const campaignRows = campaigns.map((c) => ({
        id: c.id,
        account_id: account,
        name: c.name,
        objective: c.objective ?? null,
        status: c.status ?? null,
        effective_status: c.effective_status ?? null,
        daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
        lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
        start_time: c.start_time ?? null,
        stop_time: c.stop_time ?? null,
        created_time: c.created_time ?? null,
        updated_time: c.updated_time ?? null,
        synced_at: now,
      }));

      const insights = await metaList(`${account}/insights`, {
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields: "campaign_id,campaign_name,date_start,spend,impressions,reach,clicks,inline_link_clicks,actions",
      });

      // Campanhas arquivadas ou excluídas não vêm na lista, mas podem ter resultados no período.
      for (const r of insights) {
        if (known.has(r.campaign_id)) continue;
        known.add(r.campaign_id);
        campaignRows.push({
          id: r.campaign_id, account_id: account, name: r.campaign_name, objective: null, status: null,
          effective_status: "ARCHIVED", daily_budget: null, lifetime_budget: null, start_time: null,
          stop_time: null, created_time: null, updated_time: null, synced_at: now,
        });
      }
      await upsert("campaigns", campaignRows, "id");

      await upsert(
        "campaign_insights_daily",
        insights.map((r) => ({
          campaign_id: r.campaign_id,
          account_id: account,
          date: r.date_start,
          spend: Number(r.spend ?? 0),
          impressions: Number(r.impressions ?? 0),
          reach: Number(r.reach ?? 0),
          clicks: Number(r.clicks ?? 0),
          link_clicks: Number(r.inline_link_clicks ?? 0),
          leads: pickAction(r.actions, LEAD_ACTIONS),
          conversations: pickAction(r.actions, CONVERSATION_ACTIONS),
          actions: r.actions ?? null,
          synced_at: now,
        })),
        "campaign_id,date",
      );
      details.push({ account, name: info.name, campaigns: campaigns.length, insight_rows: insights.length });
    }
    check(await db.from("sync_runs").update({ status: "concluido", details, finished_at: new Date().toISOString() }).eq("id", run.id));
    return { ok: true, since, until, details };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("sync_runs").update({ status: "erro", error: message, details, finished_at: new Date().toISOString() }).eq("id", run.id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Store Supabase
// ---------------------------------------------------------------------------

const DAILY_COLUMNS = "campaign_id,date,spend,impressions,reach,clicks,link_clicks,leads,conversations";

const store: Store = {
  async listCampaigns() {
    return check(
      await db
        .from("campaigns")
        .select("id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time")
        .order("name"),
    ) as Campaign[];
  },

  async listDaily(from, to, ids) {
    const rows: Daily[] = [];
    const size = 1000;
    for (let start = 0; ; start += size) {
      let q = db.from("campaign_insights_daily").select(DAILY_COLUMNS).gte("date", from).lte("date", to)
        .order("date").order("campaign_id").range(start, start + size - 1);
      if (ids) q = q.in("campaign_id", ids);
      const page = check(await q) as Daily[];
      rows.push(...page.map((r) => ({ ...r, spend: Number(r.spend), leads: Number(r.leads), conversations: Number(r.conversations) })));
      if (page.length < size) break;
    }
    return rows;
  },

  async listAccounts() {
    return check(await db.from("ad_accounts").select("id,name,currency,timezone,updated_at").order("name"));
  },

  async listSyncRuns(limit) {
    return check(await db.from("sync_runs").select("*").order("started_at", { ascending: false }).limit(limit));
  },

  async counts() {
    const tables: Record<string, string> = {
      campaigns: "id",
      campaign_insights_daily: "campaign_id",
      reports: "id",
      telegram_messages: "id",
    };
    const result: Record<string, number> = {};
    await Promise.all(Object.entries(tables).map(async ([t, column]) => {
      const { count, error } = await db.from(t).select(column, { count: "exact" }).limit(1);
      if (error) throw new Error(`${t}: ${error.message || error.code || "falha na contagem"}`);
      result[t] = count ?? 0;
    }));
    return result;
  },

  sync: syncFromMeta,

  async saveReport(row, pdf) {
    const today = todaySP();
    const id = crypto.randomUUID();
    const path = `${today.slice(0, 4)}/${today.slice(5, 7)}/${id}.pdf`;
    check(await db.storage.from(BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: false }));
    return check(await db.from("reports").insert({ id, ...row, file_path: path }).select().single());
  },

  async listReports(limit) {
    const rows = check(await db.from("reports").select("*").order("created_at", { ascending: false }).limit(limit)) as any[];
    if (!rows.length) return [];
    const signed = check(await db.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.file_path), 60 * 60)) as any[];
    const urls = new Map(signed.map((s) => [s.path, s.signedUrl]));
    return rows.map((r) => ({ ...r, url: urls.get(r.file_path) ?? null }));
  },

  async sendTelegram(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) throw new Error("Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nos secrets do Supabase.");
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(`Telegram: ${body.description ?? `HTTP ${res.status}`}`);
    await sleep(800);
  },

  async logTelegram(row) {
    return check(await db.from("telegram_messages").insert(row).select().single());
  },

  async listTelegram(limit) {
    return check(await db.from("telegram_messages").select("*").order("created_at", { ascending: false }).limit(limit));
  },
};

const api = createApi(store);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  try {
    if (body.action === "cron") {
      if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "Não autorizado." }, 401);
      return json(await api.cron(body.kind));
    }
    if (!APP_TOKEN || req.headers.get("x-app-token") !== APP_TOKEN) {
      await sleep(700); // desacelera tentativas repetidas
      return json({ error: "Token inválido." }, 401);
    }
    return json(await api.handle(body.action, body));
  } catch (e) {
    console.error(e);
    const status = (e as { status?: number }).status ?? 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
