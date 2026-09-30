// Ações da API. Recebe um "store" com o acesso a dados, para que a mesma lógica rode
// no Supabase (index.ts) e no servidor local de testes (dev/servidor-local.mjs).

import {
  addDays,
  assertRange,
  buildAnalysis,
  fmt,
  previousRange,
  splitMessage,
  summarize,
  telegramText,
  timeSP,
  todaySP,
} from "./core.ts";
import type { Campaign, Daily } from "./core.ts";

export type Account = { id: string; name: string | null; currency: string | null; timezone: string | null; updated_at: string };
export type SyncRun = { id: number; origin: string; days: number; status: string; details: unknown; error: string | null; started_at: string; finished_at: string | null };
export type ReportRow = { title: string; campaign_ids: string[] | null; date_from: string; date_to: string; file_size: number; summary: unknown };
export type TelegramRow = { origin: string; campaign_ids: string[] | null; date_from: string; date_to: string; text: string; status: string; error: string | null };

export type Store = {
  listCampaigns(): Promise<Campaign[]>;
  listDaily(from: string, to: string, ids: string[] | null): Promise<Daily[]>;
  listAccounts(): Promise<Account[]>;
  listSyncRuns(limit: number): Promise<SyncRun[]>;
  counts(): Promise<Record<string, number>>;
  sync(days: number, origin: string): Promise<unknown>;
  saveReport(row: ReportRow, pdf: Uint8Array): Promise<unknown>;
  listReports(limit: number): Promise<unknown[]>;
  sendTelegram(text: string): Promise<void>;
  logTelegram(row: TelegramRow): Promise<unknown>;
  listTelegram(limit: number): Promise<unknown[]>;
};

type Body = Record<string, unknown>;

const MAX_PDF_BYTES = 8 * 1024 * 1024;

function campaignIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const list = v.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x));
  return list.length ? list : null;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function createApi(store: Store) {
  async function loadSummary(from: string, to: string, ids: string[] | null) {
    const prev = previousRange(from, to);
    const [campaigns, rows, prevRows] = await Promise.all([
      store.listCampaigns(),
      store.listDaily(from, to, ids),
      store.listDaily(prev.from, prev.to, ids),
    ]);
    const selected = ids ? campaigns.filter((c) => ids.includes(c.id)) : campaigns;
    return summarize(selected, rows, prevRows, from, to);
  }

  async function analysis(params: { from: string; to: string; ids: string[] | null; compare?: boolean; title?: string; periodLabel?: string }) {
    const [summary, accounts] = await Promise.all([loadSummary(params.from, params.to, params.ids), store.listAccounts()]);
    const single = params.ids?.length === 1 ? summary.campaigns[0] : null;
    const title = params.title ?? (single ? `Análise de campanha · ${single.name}` : "Análise de tráfego · Meta Ads");
    const result = buildAnalysis(summary, { title, compare: params.compare, periodLabel: params.periodLabel });
    const accountName = accounts.length === 1 ? accounts[0].name ?? undefined : "Pedro Granado Imóveis";
    return { analysis: result, text: telegramText(result, accountName) };
  }

  async function sendAnalysis(params: Parameters<typeof analysis>[0], origin: "manual" | "agendado") {
    const { text } = await analysis(params);
    const row: TelegramRow = { origin, campaign_ids: params.ids, date_from: params.from, date_to: params.to, text, status: "enviado", error: null };
    try {
      for (const part of splitMessage(text)) await store.sendTelegram(part);
    } catch (e) {
      row.status = "falhou";
      row.error = e instanceof Error ? e.message : String(e);
      await store.logTelegram(row);
      throw e;
    }
    await store.logTelegram(row);
    return { ok: true, text };
  }

  const actions: Record<string, (b: Body) => Promise<unknown>> = {
    ping: async () => ({ ok: true }),

    campaigns: async () => ({ campaigns: await store.listCampaigns() }),

    summary: async (b) => {
      const { from, to } = assertRange(b.from, b.to);
      const [summary, accounts, runs] = await Promise.all([
        loadSummary(from, to, campaignIds(b.campaign_ids)),
        store.listAccounts(),
        store.listSyncRuns(1),
      ]);
      return { ...summary, accounts, lastSync: runs[0] ?? null };
    },

    analysis: async (b) => {
      const { from, to } = assertRange(b.from, b.to);
      return analysis({ from, to, ids: campaignIds(b.campaign_ids), compare: b.compare !== false });
    },

    telegram_send: async (b) => {
      const { from, to } = assertRange(b.from, b.to);
      return sendAnalysis({ from, to, ids: campaignIds(b.campaign_ids), compare: b.compare !== false }, "manual");
    },

    telegram_history: async () => ({ messages: await store.listTelegram(60) }),

    sync: async (b) => {
      const days = Math.min(Math.max(Number(b.days) || 7, 1), 365);
      return store.sync(days, "manual");
    },

    report_save: async (b) => {
      const { from, to } = assertRange(b.from, b.to);
      if (typeof b.pdf_base64 !== "string" || !b.pdf_base64) throw new Error("PDF não recebido.");
      const pdf = decodeBase64(b.pdf_base64);
      if (pdf.byteLength > MAX_PDF_BYTES) throw new Error("PDF acima de 8 MB.");
      const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : "Relatório de campanha";
      return store.saveReport(
        { title, campaign_ids: campaignIds(b.campaign_ids), date_from: from, date_to: to, file_size: pdf.byteLength, summary: b.summary ?? null },
        pdf,
      );
    },

    reports: async () => ({ reports: await store.listReports(100) }),

    system: async () => {
      const [accounts, runs, counts] = await Promise.all([store.listAccounts(), store.listSyncRuns(20), store.counts()]);
      return { accounts, runs, counts };
    },
  };

  async function cron(kind: unknown) {
    const today = todaySP();
    const trySync = async (days: number) => {
      try {
        await store.sync(days, "agendado");
      } catch (e) {
        console.error("Falha na sincronização agendada:", e);
      }
    };
    if (kind === "sync") return store.sync(3, "agendado");
    if (kind === "morning") {
      await trySync(3);
      const y = addDays(today, -1);
      return sendAnalysis({ from: y, to: y, ids: null, compare: true, title: "Fechamento de ontem · Meta Ads" }, "agendado");
    }
    if (kind === "evening") {
      await trySync(2);
      return sendAnalysis(
        { from: today, to: today, ids: null, compare: false, title: "Parcial de hoje · Meta Ads", periodLabel: `hoje, ${fmt.day(today)}, até ${timeSP()}` },
        "agendado",
      );
    }
    throw new Error("Rotina desconhecida.");
  }

  return {
    async handle(action: unknown, body: Body) {
      const fn = typeof action === "string" ? actions[action] : undefined;
      if (!fn) throw Object.assign(new Error("Ação desconhecida."), { status: 400 });
      return fn(body);
    },
    cron,
  };
}
