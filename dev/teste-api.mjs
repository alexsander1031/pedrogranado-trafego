// Teste rápido da lógica da API com o store em memória do servidor local.
import { createApi } from "../supabase/functions/api/app.ts";
import { addDays, todaySP } from "../supabase/functions/api/core.ts";
const camps = [{ id: "1", account_id: "a", name: "A", objective: "OUTCOME_LEADS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: 100, lifetime_budget: null, start_time: null, stop_time: null },
               { id: "2", account_id: "a", name: "B <x>", objective: "OUTCOME_LEADS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: 50, lifetime_budget: null, start_time: null, stop_time: null }];
const t = todaySP(), y = addDays(t, -1), y2 = addDays(t, -2);
const rows = [
  { campaign_id: "1", date: y, spend: 100, impressions: 5000, reach: 3000, clicks: 80, link_clicks: 60, leads: 5, conversations: 0 },
  { campaign_id: "2", date: y, spend: 80, impressions: 4000, reach: 3000, clicks: 20, link_clicks: 12, leads: 0, conversations: 0 },
  { campaign_id: "1", date: y2, spend: 90, impressions: 5000, reach: 3000, clicks: 80, link_clicks: 60, leads: 6, conversations: 0 },
];
const sent = [];
const api = createApi({
  listCampaigns: async () => camps, listDaily: async (f, to, ids) => rows.filter(r => r.date >= f && r.date <= to && (!ids || ids.includes(r.campaign_id))),
  listAccounts: async () => [{ id: "a", name: "Conta" }], listSyncRuns: async () => [], counts: async () => ({}), sync: async () => ({}),
  saveReport: async (r) => r, listReports: async () => [], sendTelegram: async (x) => sent.push(x), logTelegram: async (r) => r, listTelegram: async () => [],
});
const r = await api.cron("morning");
console.log(sent.join("\n---\n"));
const s = await api.handle("summary", { from: y, to: y });
console.log("totals", s.totals.spend, s.totals.leads, s.totals.cpl, "prev", s.previous.spend);
try { await api.handle("summary", { from: "x", to: y }); } catch (e) { console.log("erro esperado:", e.message); }
