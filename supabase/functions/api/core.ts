// Regras puras do sistema: datas, agregação de métricas, análise e texto do Telegram.
// Sem dependências de Deno ou Supabase, para rodar também no servidor local de testes.

export type Campaign = {
  id: string;
  account_id: string | null;
  name: string;
  objective: string | null;
  status: string | null;
  effective_status: string | null;
  daily_budget: number | null;
  lifetime_budget: number | null;
  start_time: string | null;
  stop_time: string | null;
};

export type Daily = {
  campaign_id: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  leads: number;
  conversations: number;
};

export type Totals = {
  spend: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  leads: number;
  conversations: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
  cpconv: number | null;
};

export type Summary = {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  totals: Totals;
  previous: Totals;
  daily: Array<Totals & { date: string }>;
  campaigns: Array<Campaign & { totals: Totals; previous: Totals }>;
};

// ---------------------------------------------------------------------------
// Datas (America/Sao_Paulo, datas no formato AAAA-MM-DD)
// ---------------------------------------------------------------------------

export const TIMEZONE = "America/Sao_Paulo";
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todaySP(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
}

export function timeSP(now = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(now);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5);
}

export function previousRange(from: string, to: string) {
  const length = daysBetween(from, to) + 1;
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

export function datesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function assertRange(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== "string" || typeof to !== "string" || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error("Período inválido. Use datas no formato AAAA-MM-DD.");
  }
  if (from > to) throw new Error("A data inicial é posterior à data final.");
  if (daysBetween(from, to) > 730) throw new Error("O período máximo é de dois anos.");
  return { from, to };
}

// ---------------------------------------------------------------------------
// Métricas da Meta
// ---------------------------------------------------------------------------

// Em ordem de preferência: o primeiro tipo encontrado é usado, para não contar o mesmo cadastro duas vezes.
export const LEAD_ACTIONS = [
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "leadgen_grouped",
];
export const CONVERSATION_ACTIONS = ["onsite_conversion.messaging_conversation_started_7d"];

export function pickAction(actions: Array<{ action_type: string; value: string }> | undefined, types: string[]): number {
  const byType = new Map((actions ?? []).map((a) => [a.action_type, Number(a.value)]));
  for (const t of types) if (byType.has(t)) return byType.get(t) ?? 0;
  return 0;
}

export const OBJECTIVES: Record<string, string> = {
  OUTCOME_LEADS: "Cadastros",
  OUTCOME_TRAFFIC: "Tráfego",
  OUTCOME_ENGAGEMENT: "Engajamento",
  OUTCOME_AWARENESS: "Reconhecimento",
  OUTCOME_SALES: "Vendas",
  OUTCOME_APP_PROMOTION: "Promoção de app",
  LEAD_GENERATION: "Cadastros",
  LINK_CLICKS: "Tráfego",
  MESSAGES: "Mensagens",
  REACH: "Alcance",
  BRAND_AWARENESS: "Reconhecimento",
  POST_ENGAGEMENT: "Engajamento",
  VIDEO_VIEWS: "Visualizações de vídeo",
  CONVERSIONS: "Conversões",
};

// Objetivos em que investir sem gerar cadastro ou conversa merece atenção.
const RESULT_OBJECTIVES = new Set(["OUTCOME_LEADS", "OUTCOME_ENGAGEMENT", "OUTCOME_SALES", "LEAD_GENERATION", "MESSAGES", "CONVERSIONS"]);

// ---------------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------------

type Sums = { spend: number; impressions: number; clicks: number; link_clicks: number; leads: number; conversations: number };
const SUM_KEYS: Array<keyof Sums> = ["spend", "impressions", "clicks", "link_clicks", "leads", "conversations"];

function emptySums(): Sums {
  return { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, leads: 0, conversations: 0 };
}

function addTo(target: Sums, row: Partial<Daily>) {
  for (const k of SUM_KEYS) target[k] += Number(row[k] ?? 0);
}

export function derive(s: Sums): Totals {
  const spend = Math.round(s.spend * 100) / 100;
  return {
    ...s,
    spend,
    ctr: s.impressions ? (s.link_clicks / s.impressions) * 100 : null,
    cpc: s.link_clicks ? spend / s.link_clicks : null,
    cpm: s.impressions ? (spend / s.impressions) * 1000 : null,
    cpl: s.leads ? spend / s.leads : null,
    cpconv: s.conversations ? spend / s.conversations : null,
  };
}

export function summarize(campaigns: Campaign[], rows: Daily[], previousRows: Daily[], from: string, to: string): Summary {
  const prev = previousRange(from, to);
  const ids = new Set(campaigns.map((c) => c.id));
  const current = rows.filter((r) => ids.has(r.campaign_id));
  const before = previousRows.filter((r) => ids.has(r.campaign_id));

  const total = emptySums();
  const previousTotal = emptySums();
  const byDate = new Map(datesInRange(from, to).map((d) => [d, emptySums()]));
  const byCampaign = new Map<string, Sums>();
  const byCampaignPrev = new Map<string, Sums>();

  for (const r of current) {
    addTo(total, r);
    const day = byDate.get(r.date);
    if (day) addTo(day, r);
    if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, emptySums());
    addTo(byCampaign.get(r.campaign_id)!, r);
  }
  for (const r of before) {
    addTo(previousTotal, r);
    if (!byCampaignPrev.has(r.campaign_id)) byCampaignPrev.set(r.campaign_id, emptySums());
    addTo(byCampaignPrev.get(r.campaign_id)!, r);
  }

  return {
    period: { from, to },
    previousPeriod: prev,
    totals: derive(total),
    previous: derive(previousTotal),
    daily: [...byDate.entries()].map(([date, s]) => ({ date, ...derive(s) })),
    campaigns: campaigns
      .map((c) => ({
        ...c,
        totals: derive(byCampaign.get(c.id) ?? emptySums()),
        previous: derive(byCampaignPrev.get(c.id) ?? emptySums()),
      }))
      .sort((a, b) => b.totals.spend - a.totals.spend || a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Formatação pt-BR
// ---------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const fmt = {
  int: (n: number) => intFmt.format(Math.round(n)),
  brl: (n: number) => brlFmt.format(n),
  pct: (n: number, digits = 2) => `${n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`,
  day: (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`,
  date: (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
};

export function rangeLabel(from: string, to: string): string {
  if (from === to) return fmt.date(from);
  return `${fmt.day(from)} a ${fmt.date(to)}`;
}

export function change(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function changeText(d: number | null): string {
  if (d == null) return "";
  if (Math.abs(d) < 1) return "estável";
  return `${d > 0 ? "+" : "-"}${fmt.pct(Math.abs(d), 0)}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

// ---------------------------------------------------------------------------
// Análise
// ---------------------------------------------------------------------------

export type Analysis = {
  title: string;
  periodLabel: string;
  compareLabel: string | null;
  overview: Array<{ label: string; value: string; change: number | null; lowerIsBetter: boolean }>;
  highlights: string[];
  alerts: string[];
  ranking: Array<{ id: string; name: string; spend: number; leads: number; conversations: number; cpl: number | null; cpconv: number | null }>;
};

export type AnalysisOptions = {
  title: string;
  compare?: boolean;
  periodLabel?: string;
};

const CTR_MIN = 0.8;
const CPL_RISE_ALERT = 25;
const MIN_SPEND_WITHOUT_RESULT = 50;

export function isActive(c: Campaign) {
  return c.effective_status === "ACTIVE";
}

export function buildAnalysis(s: Summary, opts: AnalysisOptions): Analysis {
  const compare = opts.compare !== false;
  const t = s.totals;
  const p = s.previous;
  const camps = s.campaigns.filter((c) => isActive(c) || c.totals.spend > 0);

  const overview: Analysis["overview"] = [];
  const add = (label: string, value: string, cur: number | null, prev: number | null, lowerIsBetter = false) =>
    overview.push({ label, value, change: compare ? change(cur, prev) : null, lowerIsBetter });

  add("Investimento", fmt.brl(t.spend), t.spend, p.spend);
  add("Cadastros", fmt.int(t.leads), t.leads, p.leads);
  if (t.cpl != null) add("Custo por cadastro", fmt.brl(t.cpl), t.cpl, p.cpl, true);
  if (t.conversations || p.conversations) add("Conversas iniciadas", fmt.int(t.conversations), t.conversations, p.conversations);
  if (t.cpconv != null) add("Custo por conversa", fmt.brl(t.cpconv), t.cpconv, p.cpconv, true);
  add("Cliques no link", fmt.int(t.link_clicks), t.link_clicks, p.link_clicks);
  if (t.ctr != null) add("CTR", fmt.pct(t.ctr), t.ctr, p.ctr);

  // Destaques
  const highlights: string[] = [];
  const withLeads = camps.filter((c) => c.totals.leads > 0);
  if (withLeads.length === 1 && camps.length > 1) {
    highlights.push(`Todos os cadastros do período vieram de ${withLeads[0].name}.`);
  } else if (withLeads.length > 1) {
    const solid = withLeads.filter((c) => c.totals.leads >= 3);
    const pool = solid.length ? solid : withLeads;
    const best = [...pool].sort((a, b) => (a.totals.cpl ?? Infinity) - (b.totals.cpl ?? Infinity))[0];
    highlights.push(`Menor custo por cadastro: ${best.name} (${fmt.brl(best.totals.cpl!)}, ${fmt.int(best.totals.leads)} cadastros).`);
    const most = [...withLeads].sort((a, b) => b.totals.leads - a.totals.leads)[0];
    if (most.id !== best.id) highlights.push(`Maior volume de cadastros: ${most.name} (${fmt.int(most.totals.leads)}).`);
  }
  const withConv = camps.filter((c) => c.totals.conversations > 0);
  if (withConv.length > 1) {
    const best = [...withConv].sort((a, b) => (a.totals.cpconv ?? Infinity) - (b.totals.cpconv ?? Infinity))[0];
    highlights.push(`Menor custo por conversa: ${best.name} (${fmt.brl(best.totals.cpconv!)}).`);
  }
  const spending = camps.filter((c) => c.totals.spend > 0);
  if (spending.length > 2 && t.spend > 0) {
    const share = (spending[0].totals.spend / t.spend) * 100;
    if (share >= 50) highlights.push(`${spending[0].name} concentra ${fmt.pct(share, 0)} do investimento.`);
  }

  // Pontos de atenção
  const alerts: string[] = [];
  const endLimit = addDays(s.period.to, 3);
  for (const c of camps) {
    const ct = c.totals;
    const cp = c.previous;
    if (isActive(c) && ct.spend === 0) {
      alerts.push(`${c.name}: ativa, sem entrega no período.`);
      continue;
    }
    if (ct.spend >= MIN_SPEND_WITHOUT_RESULT && !ct.leads && !ct.conversations && RESULT_OBJECTIVES.has(c.objective ?? "")) {
      alerts.push(`${c.name}: ${fmt.brl(ct.spend)} investidos sem cadastros ou conversas.`);
    }
    if (ct.impressions >= 1000 && ct.ctr != null && ct.ctr < CTR_MIN) {
      alerts.push(`${c.name}: CTR de ${fmt.pct(ct.ctr)}, abaixo de ${fmt.pct(CTR_MIN, 1)}. Vale revisar criativo e público.`);
    }
    if (compare && cp.leads >= 3 && ct.cpl != null && cp.cpl != null) {
      const rise = change(ct.cpl, cp.cpl);
      if (rise != null && rise >= CPL_RISE_ALERT) {
        alerts.push(`${c.name}: custo por cadastro subiu ${fmt.pct(rise, 0)} (de ${fmt.brl(cp.cpl)} para ${fmt.brl(ct.cpl)}).`);
      }
    }
    if (isActive(c) && c.stop_time) {
      const end = todaySP(new Date(c.stop_time));
      if (end >= s.period.to && end <= endLimit) alerts.push(`${c.name}: encerra em ${fmt.day(end)}.`);
    }
  }

  return {
    title: opts.title,
    periodLabel: opts.periodLabel ?? rangeLabel(s.period.from, s.period.to),
    compareLabel: compare ? rangeLabel(s.previousPeriod.from, s.previousPeriod.to) : null,
    overview,
    highlights,
    alerts,
    ranking: spending.map((c) => ({
      id: c.id,
      name: c.name,
      spend: c.totals.spend,
      leads: c.totals.leads,
      conversations: c.totals.conversations,
      cpl: c.totals.cpl,
      cpconv: c.totals.cpconv,
    })),
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export function telegramText(a: Analysis, accountName?: string): string {
  const e = escapeHtml;
  const head = [`<b>${e(a.title)}</b>`];
  if (accountName) head.push(e(accountName));
  head.push(`Período: ${a.periodLabel}`);
  if (a.compareLabel) head.push(`Comparação: ${a.compareLabel}`);

  const overview = a.overview.map((o) => {
    const c = changeText(o.change);
    return `${o.label}: ${o.value}${c ? ` (${c})` : ""}`;
  });

  const blocks = [head.join("\n"), `<b>Visão geral</b>\n${overview.join("\n")}`];
  if (a.highlights.length) blocks.push(`<b>Destaques</b>\n${a.highlights.map((h) => `- ${e(h)}`).join("\n")}`);
  blocks.push(
    `<b>Pontos de atenção</b>\n${a.alerts.length ? a.alerts.map((h) => `- ${e(h)}`).join("\n") : "Nenhum ponto de atenção no período."}`,
  );
  if (a.ranking.length) {
    const lines = a.ranking.map((r, i) => {
      const parts = [`Investimento ${fmt.brl(r.spend)}`];
      if (r.leads) parts.push(`Cadastros ${fmt.int(r.leads)} (${fmt.brl(r.cpl!)} cada)`);
      if (r.conversations) parts.push(`Conversas ${fmt.int(r.conversations)} (${fmt.brl(r.cpconv!)} cada)`);
      return `${i + 1}. <b>${e(r.name)}</b>\n${parts.join(" · ")}`;
    });
    blocks.push(`<b>Por campanha</b>\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

// Telegram aceita até 4096 caracteres; divide entre linhas para não quebrar tags.
export function splitMessage(text: string, limit = 4000): string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) parts.push(current);
      current = line.slice(0, limit);
    }
  }
  if (current) parts.push(current);
  return parts;
}
