# Previsão de carga do SIN — modelo × ONS

Aplicação web que **prevê a carga elétrica horária do dia seguinte** por subsistema do Sistema Interligado Nacional (SIN) e mede a qualidade dessa previsão contra dois baselines: um modelo ingênuo sazonal e a **previsão oficial programada do próprio ONS** — todos avaliados exatamente sobre as mesmas horas.

App no ar: https://desafio-squad-pandas.vercel.app

---

## O problema

Prever a carga do dia seguinte (24 horas, grão horário) para os quatro subsistemas do SIN: SE/CO, Sul, Nordeste e Norte. A previsão sozinha não diz nada sem uma régua. Por isso o projeto não entrega "um gráfico de previsão" — entrega uma **afirmação mensurável**:

> O modelo erra X% (MAPE); o ingênuo sazonal erra Y%; a programada do ONS erra Z% — todos sobre as mesmas horas de teste.

A existência de um baseline real e honesto (a programada que o ONS de fato publica) é o diferencial central: a comparação é justa porque tanto o modelo quanto o ONS preveem o dia seguinte com a mesma informação disponível.

## Fonte dos dados

API pública do ONS (`apicarga.ons.org.br`), em dois endpoints irmãos da mesma base, por área de carga:

- **Carga verificada** (`cargaverificada`, campo `val_cargaglobal`) — o alvo real.
- **Carga programada** (`cargaprogramada`, campo `val_cargaglobalprogramada`) — o baseline oficial do ONS.

Usar os dois da mesma API garante mesmo grão e mesma base. Regras de tratamento na ingestão:

- **Grão**: o ONS entrega dado semi-horário; agregamos para horário pela **média** das duas semi-horas, casando com o horizonte horário.
- **Fuso**: `din_referenciautc` vem em UTC; convertemos para Brasília (UTC−3 **fixo** — sem horário de verão no Brasil desde 2019). A hora-rótulo guarda o **início** do intervalo.
- **Não-medição**: valores 0/nulos representam horas ainda não medidas e são **descartados** — horas faltantes ficam explícitas, sem inventar valor.
- **Idempotência**: gravação com `upsert` por `(subsystem_id, ts)` — reingestão nunca duplica. A janela móvel diária reingere os últimos dias para capturar reconsolidações do ONS.

## Arquitetura

O princípio central é **separar treino de inferência**, porque as bibliotecas de previsão são Python e a Vercel só comporta funções curtas:

```
ONS (verificada + programada)
        │
        ▼
GitHub Actions (Python, agendado)   ← ingere, treina e gera a previsão; sem limite de tempo
        │  upsert
        ▼
Supabase (Postgres)                 ← séries, previsões, métricas e o artifact do modelo
        │  leitura
        ▼
Next.js + Vercel                    ← serve a previsão sob demanda (inferência em ms, TypeScript)
        │
        ▼
Usuário                             ← compara real × modelo × ONS
```

O trabalho pesado (Python) roda fora da Vercel, num job agendado do GitHub Actions, que também funciona como **keep-alive** do Supabase (escreve no banco todo dia, impedindo a pausa por inatividade). A Vercel só faz a **inferência leve**: a rota `/api/forecast` lê os coeficientes do Ridge servido (JSON no Supabase), monta o vetor de features em TypeScript e calcula `ŷ = intercepto + Σ wᵢ·xᵢ` em milissegundos — zero Python no tempo de execução.

> **Paridade Python ↔ TypeScript**: a engenharia de features no serviço (TS) reproduz exatamente a do treino (Python). Um teste de paridade automatizado (`web/scripts/parity-test.ts`) confere, sobre casos de referência gerados pelo Python, que cada feature e cada previsão batem com o original.

## Modelo de dados (Supabase)

Seis tabelas, com a comparação como cidadã de primeira classe:

| Tabela | Papel |
|---|---|
| `subsystems` | Dimensão dos 4 subsistemas (SECO, S, NE, N). |
| `load_actual` | Carga verificada horária (o alvo). |
| `load_official_forecast` | Carga programada do ONS (baseline oficial). |
| `model_runs` | Versionamento de modelo: hiperparâmetros, janela de treino, `git_commit` e o `artifact` (coeficientes do Ridge servido). |
| `predictions` | Saída do modelo por hora-alvo, versionada por execução. |
| `evaluations` | Métricas por subsistema, **predictor** (`modelo`/`naive`/`ons`) e métrica (`mape`/`mae`/`rmse`). |

A coluna `predictor` em `evaluations` é o que torna a comparação de três vias direta: os três competidores moram na mesma estrutura. Leitura pública via RLS (o painel é só-leitura).

## Modelagem e validação

**Um modelo por subsistema** — os perfis de carga diferem demais entre regiões para um modelo único.

### Regra anti-vazamento (o que torna a comparação válida)

Previsão do dia seguinte: no fim do dia D, prever as 24h de D+1 usando **apenas o que já era conhecido em D**. Daí o **piso de 24h**: nenhuma feature de carga toca dado no intervalo `(t−24h, t]` para prever a hora-alvo `t`. Sem esse piso, o modelo viraria um preditor de 1 passo à frente — artificialmente bom e injusto contra a programada do ONS, que é genuinamente do dia seguinte.

### Escada de modelos

1. **Ingênuo sazonal** — `ŷ(t) = carga(t−168h)` (mesma hora, semana anterior). O piso a ser batido.
2. **Programada ONS** — a previsão oficial. A barra a perseguir.
3. **Ridge** (linear regularizado) — interpretável, rápido, e cujos coeficientes serializam para JSON. **É o modelo servido ao vivo** pela `/api/forecast`.
4. **LightGBM** (gradient boosting) — capta não-linearidades. **É o campeão** reportado na comparação.

### Teste retroativo simulando previsões dia após dia (walk-forward)

Validação cruzada aleatória é proibida em série temporal (embaralhar vaza o futuro no passado). Usamos a janela deslizante de origem:

- Origens de re-treino no início de cada mês do período de teste; **janela de treino expansível**.
- Em cada origem `O`, o treino usa alvos **estritamente anteriores a `O`** (nenhuma hora prevista é vista no treino) e prevê o bloco `[O, próxima O)`.
- Os **três preditores são avaliados nas mesmas horas** — única forma de a comparação ser honesta.

O `pipeline/src/model.py` grava três execuções: `ridge_v1` e `lgbm_v1` (com `predictions` + `evaluations` do retroativo) e `ridge_v1_served` (o artifact treinado em todo o histórico, para a inferência em TS).

## Resultados

MAPE do campeão (LightGBM) contra a programada do ONS, no teste retroativo de 12 meses:

| Subsistema | LightGBM | ONS | Vencedor |
|---|---|---|---|
| SE/CO | 2,80% | 2,28% | ONS |
| Sul | 4,13% | 4,22% | **Modelo** |
| Nordeste | 2,45% | 2,62% | **Modelo** |
| Norte | 2,42% | 2,27% | ONS |

A leitura honesta é o que dá força ao projeto: o ONS lidera onde já é muito preciso (SE/CO e Norte), e **o modelo alcança e supera o ONS justamente nas duas regiões onde prever é mais difícil** (Sul e Nordeste, de maior erro). Atingir o operador nacional onde ele mais sofre é um resultado defensável.

## Como rodar

**Pipeline (Python).** Requer `DATABASE_URL` do Supabase num `.env` na raiz.

```bash
pip install -r pipeline/requirements.txt

# Ingestão (janela móvel padrão dos últimos ~10 dias; ou backfill com --inicio/--fim)
python pipeline/ingest_verificada.py
python pipeline/ingest_programada.py

# Treino + teste retroativo + artifact servido
python pipeline/src/model.py
```

**Aplicação web (Next.js).** Em `web/.env.local`: `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

```bash
cd web
npm install
npm run dev      # desenvolvimento
npm run build    # validação estrita (sempre antes de publicar)
```

## Limitações

- **Feriados móveis ausentes**: `pipeline/data/holidays_br.json` (2023–2027) cobre feriados nacionais fixos + Sexta-feira Santa, mas **não inclui Carnaval nem Corpus Christi**. Esses dias caem no balde "dia útil" no recorte de erro por tipo de dia.
- **Atraso de publicação do ONS**: a carga verificada é publicada com defasagem (e reconsolidada depois). Mesmo com o pipeline rodando, é normal o gráfico ficar um ou dois dias atrás do calendário — isso é da fonte, não do sistema.
- **Falha de 24h na programada de NE/N**: um intervalo de 24h sem programada nesses subsistemas é tratado como não-medição na origem; resolvido por *inner join*, sem imputação.
- **Modelo servido × campeão**: a `/api/forecast` serve o **Ridge** (linear, serializável para inferência em TS); o **LightGBM** é o campeão reportado na comparação, mas não é servido ao vivo (não roda barato em TypeScript).
- **Sem variáveis climáticas**: temperatura e afins ficaram fora do escopo desta versão.

## Stack

Cursor (IDE assistida por IA) · Python (pandas, scikit-learn, LightGBM) · Supabase (Postgres) · Next.js + Recharts · Vercel · GitHub Actions.

```
pipeline/    ingestão (ingest.py + wrappers), modelagem (model.py), feriados, casos de paridade
supabase/    migration do schema (6 tabelas + RLS)
web/         app Next.js: painel, /api/forecast, inferência em TS (lib/forecast)
```