# Lead Radar

https://github.com/user-attachments/assets/3740aa1d-bdfb-484c-a176-716bf4a7fce9

An n8n workflow that takes an inbound B2B lead, checks what the company actually builds on GitHub, scores fit from 1 to 5 with an LLM, and saves the result to Postgres. It was designed around what a GTM engineer at a developer-infrastructure company does: enrichment, scoring, hygiene, and keeping the outbound engine running without manual work.

The ICP is set for Unikraft (infrastructure, serverless, sandboxed compute). It lives in two clearly marked blocks (`nodes/02_signals.js` and `nodes/03_build_prompt.js`), so you can retarget it for any product.

## How it works

```
POST /webhook/lead-intake
  -> Normalize & Validate     clean domain, derive GitHub org, check email, flag freemail
  -> Valid?                   no: reply 422 with the reasons
  -> GitHub Repos             public repos via REST API (timeout, never throws on 404/403)
  -> Compute Signals          active repos, stars, languages, keyword hits, rule score 0-100 -> tier 1-5
  -> Enough data for AI?      no GitHub data: skip the LLM so it never has to guess
  -> Build Prompt -> Claude or Groq Score (3 retries)
  -> Parse & Merge            tolerant JSON parsing, range checks, grounding check, fallback to rules
  -> Hot lead?                score 4+: Slack alert (node ships disabled)
  -> Upsert Lead              Postgres, keyed on domain, so re-sends update instead of duplicating
  -> Respond OK               returns the scored lead to the caller
```

A second workflow (`error-handler.json`) logs failed executions to a `workflow_errors` table.

## Design decisions worth knowing

- **Rules and LLM both score.** The rule score is a free baseline and the fallback if the model is down or returns junk. When the two differ by 2+ points the lead is flagged `needs_review` rather than trusted blindly.
- **No data, no guess.** Companies with no public GitHub org get status `no_github_data`, not a made-up score. Rate limits or network errors get `needs_retry` and a null score, so a temporary failure never looks like "bad lead".
- **Grounded openers.** Any number in a generated cold-email line must appear in the facts sent to the model, otherwise the opener is dropped.
- **Code lives in files.** The Code-node scripts are in `nodes/` so they can be tested and diffed. `workflows/build_workflow.py` inlines them into the importable JSON.
- **Idempotent writes.** Same domain twice updates the row.

## Run it

Needs Docker, a Groq or Anthropic API key, and ideally a GitHub personal access token (unauthenticated GitHub allows only 60 requests/hour).

```bash
cp .env.example .env            # set both secrets
docker compose up -d
python3 workflows/build_workflow.py --github-auth   # or without the flag for anonymous GitHub
```

1. Open http://localhost:5678 and create the owner account.
2. Credentials, using exactly these names:
   - **Groq API key** (if using Groq): type Header Auth, name `Authorization`, value `Bearer <your key>`
   - **Anthropic API key** (if using Claude): type Header Auth, name `x-api-key`, value your key
   - **GitHub token** (only if you built with `--github-auth`): Header Auth, name `Authorization`, value `Bearer <token>`
   - **CRM Postgres**: host `postgres`, database `crm`, user `crm`, password from `.env`
3. Import `workflows/lead-radar.json` and `workflows/error-handler.json`.
4. In Lead Radar's settings, set **Error Workflow** to the error handler.
5. Optional: paste a Slack incoming webhook URL into the `Slack Alert` node and enable it.
6. Activate the workflow, then try one lead:

```bash
curl -s -X POST localhost:5678/webhook/lead-intake -H 'Content-Type: application/json' \
  -d '{"company":"Fly.io","domain":"fly.io","github_org":"superfly"}'
```

## Choosing the LLM provider

The builder supports two providers. Pick one when you generate the workflow:

```bash
python3 workflows/build_workflow.py --provider groq --github-auth             # free tier, OpenAI-style API
python3 workflows/build_workflow.py --provider anthropic --github-auth        # Claude, needs API credit
python3 workflows/build_workflow.py --provider groq --model <model-id>        # override the default model
python3 workflows/build_workflow.py --provider groq --hide-keyword-hits       # experiment: hide rule signals from the model
```

**Groq setup**

1. Create a free account at console.groq.com and make an API key under API Keys.
2. In n8n create a credential of type **Header Auth** named exactly `Groq API key`: header name `Authorization`, value `Bearer <your key>`.
3. Check the key and list the models available to you:
   `curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`
4. Import the workflow built with `--provider groq`.
5. Run the eval slowly, because free tiers cap requests and tokens per minute: `python3 eval/run_eval.py --delay 8`. Check your limits at console.groq.com/settings/limits.

The default Groq model is `openai/gpt-oss-120b`. Model names change; if the API rejects it, pick one from step 3 and pass it with `--model`. State the model you used whenever you report results.

**`--hide-keyword-hits` experiment.** The keyword list is produced by the rule stage and can anchor the model — large GitHub orgs accumulate infrastructure keywords even when infrastructure is not their product. This flag removes `keyword_hits` from the facts sent to the model and has it judge from repo names, descriptions and top repos directly. Label a fresh holdout set before running either variant so the comparison is not inflated.

## Tests and evaluation

```bash
node --test tests/test_nodes.js      # 19 unit tests for the four Code-node scripts
```

To measure the scorer, label your own data. `data/leads.csv` has 35 real companies plus 5 deliberately dirty rows. Fill `human_score` (1 to 5) for each company yourself, from your own judgment of Unikraft's ICP, then:

```bash
python3 eval/run_eval.py --url http://localhost:5678/webhook/lead-intake
```

It prints exact agreement, within-one agreement, mean error, hot-lead precision and recall (score 4+), Spearman correlation and a confusion matrix, for the final score, the LLM alone, and the rules alone. That comparison shows whether the LLM step earns its cost. Report whatever it says, with the sample size.

## End-to-end test without any keys

`tests/e2e/` runs the real workflow inside a real n8n, with small local mock servers standing in for GitHub and Claude. It covers a strong fit, a weak fit, a missing GitHub org, a rate limit, junk from the model, a model outage, a messy URL, and invalid input.

```bash
node tests/e2e/mock_servers.js &
python3 workflows/build_workflow.py --github-auth
python3 tests/e2e/patch_workflow.py workflows/lead-radar.json /tmp/e2e.json
n8n import:workflow --input=/tmp/e2e.json && n8n publish:workflow --id=leadRadarE2E00001 && n8n start
python3 tests/e2e/run_e2e.py
```

## Evaluation results

Labels were applied by a single person to 33 companies (out of 40 test rows; 4 had no public GitHub org and 3 were deliberately invalid). The prompt was not tuned toward these labels. Numbers should be read as suggestive, not proof, at n=33.

*Run details:* Evaluated Sept 30, 2026. Model: `openai/gpt-oss-120b` (max_tokens: 1024). Prompt version: `nodes/03_build_prompt.js` at commit `bb96cf3`.

| Scorer | Exact | Within 1 pt | MAE | Hot-lead precision | Hot-lead recall | Spearman |
|--------|-------|-------------|-----|--------------------|-----------------|----------|
| LLM (Groq `openai/gpt-oss-120b`) | **55%** | **91%** | **0.61** | **0.83** | **0.95** | **0.76** |
| Rules only | 36% | 70% | 1.12 | 0.63 | 0.95 | 0.49 |

All figures are for n=33. Hot lead = score 4 or 5. LLM fallbacks to rules: 0 (every lead with GitHub data got a valid LLM score).

**Known gaps.** The three largest misses are Siemens, SAP and Tailscale, where the LLM scored 5 against labels of 2, 2 and 3. In each case the model's stated reason quotes the `keyword_hits` list almost verbatim — that list is produced by the rule stage, and large GitHub orgs accumulate those keywords even when infrastructure is not their product. Hiding `keyword_hits` from the model and having it judge from repo names and descriptions directly is a better experiment than patching the prompt. See `--hide-keyword-hits` above.

The upward bias on label-4 companies (all 7 scored 5) may partly reflect the labels: HashiCorp, Docker and Deno are plausibly 5s. Since both 4 and 5 count as hot, the practical impact is low.

## Status of this build

| Part | State |
|---|---|
| Code-node logic | 19 unit tests pass |
| Eval metric maths | checked against hand-worked examples |
| Import and run in n8n 2.41.3 | both workflows import and run; webhook, GitHub fetch, LLM call, Postgres upsert all verified live |
| Postgres schema and upsert | tested against Postgres 16; repeat domains update the existing row |
| Error-handler workflow | imports and activates |
| Live GitHub and Groq calls | verified on 33 leads; 0 parse errors, 0 LLM fallbacks to rules |
| Accuracy numbers | frozen above; prompt not tuned to labels |
