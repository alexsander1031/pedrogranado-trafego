// Gera o SQL dos agendamentos (pg_cron) com os dados do projeto preenchidos.
// Uso: node scripts/gerar-agendamentos.mjs > supabase/agendamentos.sql
// Lê PROJECT_REF e CRON_SECRET de supabase/.env

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../supabase/.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const ref = env.PROJECT_REF;
const secret = env.CRON_SECRET;
if (!ref || !secret) {
  console.error("Preencha PROJECT_REF e CRON_SECRET em supabase/.env");
  process.exit(1);
}

const job = (name, schedule, kind) => `select cron.schedule('${name}', '${schedule}', $job$
  select net.http_post(
    url := 'https://${ref}.supabase.co/functions/v1/api',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "${secret}"}'::jsonb,
    body := '{"action": "cron", "kind": "${kind}"}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);`;

console.log(`-- Agendamentos da Gestão de Tráfego (horários em UTC; Brasília = UTC-3)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove versões anteriores, se existirem
select cron.unschedule(jobname) from cron.job where jobname like 'trafego-%';

-- Sincroniza os últimos 3 dias a cada hora, aos 10 minutos
${job("trafego-sync", "10 * * * *", "sync")}

-- 06h00 em Brasília: fechamento de ontem no Telegram
${job("trafego-telegram-06h", "0 9 * * *", "morning")}

-- 19h00 em Brasília: parcial de hoje no Telegram
${job("trafego-telegram-19h", "0 22 * * *", "evening")}
`);
