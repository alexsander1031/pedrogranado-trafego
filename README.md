# Gestão de Tráfego · Pedro Granado Imóveis

Sistema interno para acompanhar as campanhas do Meta Ads: painel com gráficos, histórico por campanha, relatórios em PDF e análises enviadas ao Telegram. Funciona no computador e no celular (pode ser adicionado à tela inicial).

## Como funciona

```
Navegador (GitHub Pages)  ──►  Edge Function "api" (Supabase)  ──►  Meta Ads API
  index.html + assets/          valida o token de acesso             Telegram Bot API
                                lê e grava no banco
                                        │
                                        ▼
                           Postgres + Storage (Supabase)
                           campanhas, métricas diárias, relatórios em PDF,
                           envios ao Telegram, histórico de sincronizações
```

- Os tokens da Meta e do Telegram ficam apenas nos secrets do Supabase. Nada sensível vai para o navegador ou para o GitHub.
- As tabelas têm RLS ativo e nenhuma política pública: só a Edge Function acessa os dados.
- O token de acesso ao sistema é o secret `APP_TOKEN` (definido em `supabase/.env`, que não vai para o GitHub). Para trocar, altere o secret e rode o deploy de secrets de novo.

### Rotinas automáticas (pg_cron)

| Horário (Brasília) | O que faz |
|---|---|
| A cada hora, aos 10 min | Sincroniza os últimos 3 dias com a Meta |
| 06h00 | Envia ao Telegram o fechamento de ontem, comparado ao dia anterior |
| 19h00 | Envia ao Telegram a parcial de hoje |

### Métricas

- **Cadastros**: formulários instantâneos e leads do pixel, contados uma vez por campanha.
- **Conversas**: conversas iniciadas por mensagem (WhatsApp, Messenger, Direct).
- **CTR**: cliques no link divididos por impressões.
- As ações brutas da Meta ficam guardadas na coluna `actions`, para novas métricas no futuro sem perder histórico.

### Pontos de atenção gerados na análise

Campanha ativa sem entrega; investimento a partir de R$ 50 sem cadastros ou conversas (em campanhas de cadastro, mensagens ou vendas); CTR abaixo de 0,8% com mais de mil impressões; custo por cadastro 25% acima do período anterior; campanha que encerra nos próximos 3 dias. Os limites ficam no início de `supabase/functions/api/core.ts`.

---

## Publicação

Pré-requisitos: Node.js instalado, uma conta no GitHub e uma no Supabase.

### 1. Supabase

1. Crie um projeto em [supabase.com](https://supabase.com) (região São Paulo). O ID do projeto aparece na URL do painel (`/project/<ID>`).
2. Preencha `supabase/.env` com o `PROJECT_REF`, o token da Meta, os IDs das contas de anúncio e os dados do bot do Telegram. O `APP_TOKEN` e o `CRON_SECRET` já estão preenchidos.
3. No terminal, dentro desta pasta:

```bash
npx supabase login
```

```bash
npx supabase link --project-ref SEU_PROJECT_REF
```

```bash
npx supabase db push
```

```bash
npx supabase secrets set --env-file supabase/.env
```

```bash
npx supabase functions deploy api --no-verify-jwt
```

4. Gere o SQL dos agendamentos e rode o conteúdo de `supabase/agendamentos.sql` no **SQL Editor** do Supabase:

```bash
node scripts/gerar-agendamentos.mjs > supabase/agendamentos.sql
```

### 2. GitHub Pages

1. Em `assets/config.js`, troque `SEU-PROJETO` pelo ID do projeto Supabase.
2. Crie o repositório e envie os arquivos:

```bash
gh auth login
```

```bash
gh repo create pedrogranado-trafego --private --source . --push
```

3. No repositório, em **Settings > Pages**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)`.

GitHub Pages em repositório privado exige plano pago do GitHub (Pro, Team ou Enterprise). Em plano gratuito, o repositório precisa ser público. O código não contém nenhum segredo, mas fica visível.

### 3. Primeiro acesso

1. Abra o endereço do GitHub Pages e entre com o token.
2. Em **Sistema**, clique em **Importar histórico de 90 dias**.
3. Em **Telegram**, use **Pré-visualizar** e depois **Enviar ao Telegram** para validar o bot.

---

## Teste local

Roda a interface com dados fictícios, usando a mesma lógica da Edge Function, sem acessar a Meta nem o Telegram:

```bash
node dev/servidor-local.mjs
```

Acesse `http://localhost:8787` com o token de `supabase/.env`.

## Estrutura

```
index.html                     página única do sistema
assets/app.js                  interface, gráficos e geração do PDF
assets/styles.css              visual (claro e escuro, desktop e celular)
assets/config.js               endereço da API
supabase/functions/api/        Edge Function
  index.ts                     HTTP, Supabase, Meta e Telegram
  app.ts                       ações da API
  core.ts                      métricas, análise e texto do Telegram
supabase/migrations/           estrutura do banco
scripts/gerar-agendamentos.mjs SQL das rotinas automáticas
dev/servidor-local.mjs         servidor de testes com dados fictícios
```
