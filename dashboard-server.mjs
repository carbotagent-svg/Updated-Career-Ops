#!/usr/bin/env node
// dashboard-server.mjs — interactive job search dashboard
// Run:  node dashboard-server.mjs
// Open: http://localhost:3001
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, URL as NodeURL } from 'url';
import { spawn } from 'child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── Keyword extraction ──────────────────────────────────────────────────────

const TECH_RE = /\b(Python|JavaScript|TypeScript|SQL|R(?=[\s,.]|$)|Go(?=[\s,.]|$)|Java(?!Script)|Scala|Rust|C\+\+|React|Node\.?js|Docker|Kubernetes|K8s|AWS|GCP|Azure|Spark|Kafka|Airflow|dbt|Tableau|Power\s*BI|TensorFlow|PyTorch|scikit.learn|NLP|LLM|RAG|API|ETL|CI\/CD|Git|PostgreSQL|Postgres|MongoDB|Redis|Snowflake|BigQuery|Databricks|MLflow|Grafana|FastAPI|Django|Flask|vector\s+(?:search|DB|database|store)|embeddings|LangChain|OpenAI|transformer|BERT|GPT|fine.tun\w*|prompt\s+engineer\w*|agentic|multi.agent|orchestration|feature\s+store|data\s+warehouse|data\s+lake|microservices|REST|GraphQL|Terraform|Helm|A\/B\s+testing|experimentation|machine\s+learning|deep\s+learning|computer\s+vision|recommendation|time\s+series|reinforcement\s+learning|statistics|hypothesis\s+test\w*|causal\s+\w+|observability|monitoring|inference|evaluation|Looker|Mixpanel|DuckDB|Polars|Pandas|NumPy|Matplotlib|Seaborn|Plotly|Streamlit|HuggingFace|Hugging\s+Face|RLHF|HITL|Redshift|Hive|Presto|Trino|dbt\s+Core|Fivetran|Stitch|Segment|Amplitude|Heap|Braze|Salesforce|Sigma|Mode|Hex|Jupyter|Prefect|Dagster|Great\s+Expectations|Monte\s+Carlo|Soda|Elementary|PowerBI)\b/gi;

const ROLE_RE = /\b(data\s+modeling|data\s+pipeline|data\s+quality|data\s+governance|data\s+catalog|business\s+intelligence|self.serve\s+analytics|real.time\s+analytics|batch\s+processing|stream\s+processing|A\/B\s+testing|causal\s+inference|predictive\s+modeling|anomaly\s+detection|root\s+cause\s+analysis|SQL\s+optimization|dimensional\s+modeling|star\s+schema|feature\s+engineering|model\s+deployment|analytics\s+engineering|data\s+visualization|cross.functional|stakeholder\s+management|product\s+analytics|growth\s+analytics|marketing\s+analytics|financial\s+modeling|data\s+driven|reporting\s+automation|KPI\s+tracking|metric\s+definition|experiment\s+design|statistical\s+significance|regression\s+analysis|time\s+series\s+forecasting)\b/gi;

function extractKeywords(text) {
  const seen = new Set();
  const result = [];
  for (const re of [TECH_RE, ROLE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const kw = m[0].trim().replace(/\s+/g, ' ');
      const key = kw.toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(kw); }
    }
  }
  return result;
}

// ─── URL fetcher ─────────────────────────────────────────────────────────────

function fetchUrl(rawUrl, redirects = 0) {
  if (redirects > 4) return Promise.resolve('');
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new NodeURL(rawUrl); } catch { return resolve(''); }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.host}${loc}`;
        res.resume();
        return fetchUrl(next, redirects + 1).then(resolve);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8', 0, 150000)));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(12000, () => { req.destroy(); resolve(''); });
  });
}

async function extractFromUrl(url) {
  const raw = await fetchUrl(url);
  if (!raw) return { keywords: [], error: 'Could not reach page — it may require login or JavaScript to render.' };
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 100) return { keywords: [], error: 'Page appears JavaScript-rendered (Workday, etc). Open the job URL and paste the description text instead.' };
  return { keywords: extractKeywords(text.slice(0, 60000)) };
}

// ─── Data parsers ─────────────────────────────────────────────────────────────

function detectATS(url) {
  if (!url) return '';
  const u = url.toLowerCase();
  if (u.includes('greenhouse.io') || u.includes('boards.greenhouse')) return 'Greenhouse';
  if (u.includes('lever.co')) return 'Lever';
  if (u.includes('ashbyhq.com')) return 'Ashby';
  if (u.includes('workday') || u.includes('myworkdayjobs')) return 'Workday';
  if (u.includes('smartrecruiters')) return 'SmartRecruiters';
  if (u.includes('workable')) return 'Workable';
  if (u.includes('bamboohr')) return 'BambooHR';
  if (u.includes('recruitee')) return 'Recruitee';
  if (u.includes('successfactors')) return 'SAP SF';
  if (u.includes('oraclecloud')) return 'Oracle';
  return '';
}

function parseScanHistory(rootDir) {
  const fp = path.join(rootDir, 'data', 'scan-history.tsv');
  if (!fs.existsSync(fp)) return [];
  const text = fs.readFileSync(fp, 'utf8');
  const jobs = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('url\t')) continue;
    const f = t.split('\t');
    if (f.length < 2) continue;
    const url = f[0].trim();
    if (!url.startsWith('http')) continue;
    jobs.push({
      url,
      firstSeen: f[1]?.trim() || '',
      portal:    f[2]?.trim() || '',
      title:     f[3]?.trim() || '',
      company:   f[4]?.trim() || '',
      status:    f[5]?.trim() || '',
      location:  f[6]?.trim() || '',
      ats:       detectATS(url),
    });
  }
  return jobs.slice(-800).reverse();
}

function getPipelineUrls(rootDir) {
  const fp = path.join(rootDir, 'data', 'pipeline.md');
  if (!fs.existsSync(fp)) return new Set();
  const urls = new Set();
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    const m = line.match(/^- \[[ x]\] (https?:\/\/\S+)/);
    if (m) urls.add(m[1].trim());
  }
  return urls;
}

function parseApplications(rootDir) {
  const fp = path.join(rootDir, 'data', 'applications.md');
  if (!fs.existsSync(fp)) return [];
  const apps = [];
  for (const raw of fs.readFileSync(fp, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---')) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length < 6) continue;
    apps.push({ company: cells[2], role: cells[3], status: cells[5] });
  }
  return apps;
}

function parsePipeline(rootDir) {
  const fp = path.join(rootDir, 'data', 'pipeline.md');
  if (!fs.existsSync(fp)) return { pending: [], processed: [] };
  const text = fs.readFileSync(fp, 'utf8');
  const pending = [], processed = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('## Pending')) { section = 'pending'; continue; }
    if (line.startsWith('## Processed')) { section = 'processed'; continue; }
    if (line.startsWith('## ')) { section = ''; continue; }
    const m = line.match(/^- \[([ x])\] (.+)/);
    if (!m) continue;
    const rest = m[2].replace(/~~([^~]+)~~/g, '$1').trim();
    const parts = rest.split(' | ');
    const entry = { url: parts[0].trim(), company: parts[1]?.trim() || '', role: parts[2]?.trim() || '', ats: detectATS(parts[0]) };
    if (section === 'pending' && m[1] !== 'x') pending.push(entry);
    else processed.push(entry);
  }
  return { pending, processed };
}

// ─── Pipeline management ──────────────────────────────────────────────────────

function addToPipeline(url, company, role) {
  const fp = path.join(ROOT, 'data', 'pipeline.md');
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp,
      `# Pipeline — Pending URLs\n\nPaste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.\n\n## Pending\n\n- [ ] ${url} | ${company} | ${role}\n\n## Processed\n`,
      'utf8');
    return 'added';
  }
  const content = fs.readFileSync(fp, 'utf8');
  if (content.includes(url)) return 'already_exists';
  const entry = `- [ ] ${url} | ${company} | ${role}`;
  const updated = content.includes('\n## Pending\n')
    ? content.replace('\n## Pending\n', `\n## Pending\n\n${entry}\n`)
    : content + '\n' + entry + '\n';
  fs.writeFileSync(fp, updated, 'utf8');
  return 'added';
}

// ─── Job scoring ─────────────────────────────────────────────────────────────

// AI-first companies get a bonus — they're higher-signal matches
const AI_FIRST_COS = new Set([
  'anthropic','openai','deepmind','google deepmind','mistral','cohere','ai21','hugging face',
  'huggingface','inflection','character.ai','adept','stability ai','scale ai','runway',
  'perplexity','together ai','modal','replicate','weights & biases','wandb',
]);

function loadScoringProfile(rootDir) {
  const profile = { skills: new Set(), targetRoles: [], targetLevel: 'mid', targetLocation: '' };

  // Parse cv.md for skills
  const cvPath = path.join(rootDir, 'cv.md');
  if (fs.existsSync(cvPath)) {
    const cvText = fs.readFileSync(cvPath, 'utf8');
    TECH_RE.lastIndex = 0;
    let m;
    while ((m = TECH_RE.exec(cvText)) !== null) profile.skills.add(m[0].toLowerCase().trim());
  }

  // Parse config/profile.yml (simple regex — no yaml dep needed)
  const profPath = path.join(rootDir, 'config', 'profile.yml');
  if (fs.existsSync(profPath)) {
    const text = fs.readFileSync(profPath, 'utf8');
    const primaryBlock = text.match(/primary:\s*\n((?:\s+-\s+.+\n?)*)/);
    if (primaryBlock) {
      for (const line of primaryBlock[1].split('\n')) {
        const r = line.match(/^\s+-\s+"?(.+?)"?\s*$/);
        if (r) profile.targetRoles.push(r[1].toLowerCase());
      }
    }
    const locMatch = text.match(/location:\s*"?([^"\n,]+)/);
    if (locMatch) profile.targetLocation = locMatch[1].toLowerCase().trim();
  }
  return profile;
}

function scoreJob(job, profile) {
  const t   = (job.title    || '').toLowerCase();
  const loc = (job.location || '').toLowerCase();
  const co  = (job.company  || '').toLowerCase();
  let score = 0;

  // ── 1. Role centrality (0-40) ────────────────────────────────────────────
  if (profile.targetRoles.length) {
    // Score against user's explicitly configured target roles
    let best = 0;
    for (const role of profile.targetRoles) {
      const words = role.split(/\s+/).filter(w => w.length > 2);
      const matched = words.filter(w => t.includes(w)).length;
      best = Math.max(best, (matched / words.length) * 40);
    }
    score += best;
  } else {
    // Default: rank by how central AI/data engineering is to the role itself
    if (/\b(ai|ml|machine learning|deep learning)\s+(engineer|researcher|scientist)\b/.test(t))     score += 40;
    else if (/\b(applied scientist|research scientist|research engineer)\b/.test(t))                  score += 38;
    else if (/\b(data scientist|analytics engineer|data analytics engineer)\b/.test(t))              score += 36;
    else if (/\b(data engineer|ml engineer|mlops engineer)\b/.test(t))                               score += 34;
    else if (/\b(data analyst|business intelligence|bi engineer|bi analyst)\b/.test(t))              score += 30;
    else if (/\b(llm|genai|generative ai|llmops|ai product|ai platform|ai infra)\b/.test(t))        score += 32;
    else if (/\b(forward deployed|solutions engineer|solutions architect)\b/.test(t))                score += 22;
    else if (/\b(product manager|technical program)\b/.test(t))                                      score += 14;
    else if (/\b(sales|marketing|gtm|account|customer success|recruiter)\b/.test(t))                score +=  6;
    else if (/\b(ai|ml|data|llm|agent|genai)\b/.test(t))                                            score += 20; // AI-adjacent
    else                                                                                              score += 10;
  }

  // ── 2. Seniority fit (0-25) — mid-level sweet spot ──────────────────────
  if (/\b(intern|co-?op|internship)\b/.test(t))                                                      score +=  0;
  else if (/\b(director|vp|vice president|head of|chief)\b/.test(t))                                score +=  6;
  else if (/\b(staff|principal|distinguished)\b/.test(t))                                            score += 12;
  else if (/\b(senior|sr\.?|lead|ii|iii)\b/.test(t))                                                score += 25;
  else if (/\b(junior|jr\.?|associate|entry|new grad|university grad|i\b)\b/.test(t))               score += 16;
  else                                                                                                score += 22; // no qualifier → assume mid

  // ── 3. Location (0-20) ──────────────────────────────────────────────────
  const userLoc = profile.targetLocation;
  if (/remote|anywhere|worldwide|fully remote/.test(loc))                                             score += 20;
  else if (/hybrid/.test(loc))                                                                        score += 14;
  else if (userLoc && loc.includes(userLoc))                                                          score += 18;
  else if (/united states|usa|us\b/.test(loc))                                                        score += 10;
  else if (/new york|nyc|san francisco|sf\b|boston|seattle|austin|chicago/.test(loc))                score +=  8;
  else if (loc)                                                                                        score +=  3;

  // ── 4. Company signal (0-15) ─────────────────────────────────────────────
  if (AI_FIRST_COS.has(co))                                                                           score += 15;
  else if (co)                                                                                         score +=  5;

  // ── 5. Skills overlap from CV (0-10, only when cv.md exists) ────────────
  if (profile.skills.size > 0) {
    let hits = 0;
    for (const sk of profile.skills) { if (t.includes(sk)) hits++; }
    score += Math.min(10, hits * 4);
  }

  // Hard penalty for intern/co-op
  if (/\b(intern|co-?op|internship)\b/.test(t)) score = Math.min(score, 18);

  return Math.min(100, Math.round(score));
}

function syncTopToPipeline(n, rootDir) {
  const jobs = parseScanHistory(rootDir);
  if (!jobs.length) return { synced: 0, error: 'No scan history found. Run a scan first.' };
  const profile = loadScoringProfile(rootDir);
  const top = jobs
    .map(j => ({ ...j, score: scoreJob(j, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  const entries = top.map(j => `- [ ] ${j.url} | ${j.company || ''} | ${j.title || ''}`).join('\n');
  const content = `# Pipeline — Pending URLs\n\nTop ${top.length} jobs by match score. Run \`/career-ops pipeline\` to evaluate.\n\n## Pending\n\n${entries}\n\n## Processed\n`;
  fs.writeFileSync(path.join(rootDir, 'data', 'pipeline.md'), content, 'utf8');
  return { synced: top.length, topScore: top[0]?.score ?? 0, cutoffScore: top[top.length - 1]?.score ?? 0 };
}

// ─── portals.yml bootstrap ───────────────────────────────────────────────────

function ensurePortals() {
  const dest = path.join(ROOT, 'portals.yml');
  if (fs.existsSync(dest)) return true;
  const src = path.join(ROOT, 'templates', 'portals.example.yml');
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  console.log('[dashboard] portals.yml created from template');
  return true;
}

// ─── HTML page ────────────────────────────────────────────────────────────────

function buildPage() {
  const scanJobs = parseScanHistory(ROOT);
  const pipelineUrls = getPipelineUrls(ROOT);
  const pipeline = parsePipeline(ROOT);
  const apps = parseApplications(ROOT);
  const ts = new Date().toLocaleString();

  const scoringProfile = loadScoringProfile(ROOT);
  const enriched = scanJobs
    .map(j => ({ ...j, inPipeline: pipelineUrls.has(j.url), score: scoreJob(j, scoringProfile) }))
    .sort((a, b) => b.score - a.score);

  const dataJson = JSON.stringify({ scanJobs: enriched, pipeline, apps, generated: new Date().toISOString() });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>career-ops · live</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0B0B0F;--surface:#111116;--surface2:#18181F;
  --border:#22222D;--border-hi:#333345;
  --text:#E2E0EF;--muted:#7B7994;--subtle:#4B4964;
  --gold:#C49450;--gold-bg:#1A1206;
  --green:#5CC98A;--green-bg:#061509;
  --blue:#5BA0F0;--blue-bg:#060F1E;
  --red:#E85555;--red-bg:#1A0606;
  --amber:#E8943A;--amber-bg:#1A0D04;
  --purple:#9D6FE8;--purple-bg:#120A1E;
  --cyan:#5BC4CE;--cyan-bg:#051418;
  --mono:'Menlo','Monaco','Consolas','Courier New',monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.5;min-height:100vh}
a{color:var(--gold);text-decoration:none}a:hover{text-decoration:underline}

.header{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--border)}
.wordmark{font-family:var(--mono);font-size:14px;display:flex;align-items:center;gap:8px}
.wordmark-app{color:var(--gold);font-weight:700}
.wordmark-sep{color:var(--border-hi)}
.wordmark-sub{color:var(--subtle)}
.live-dot{display:inline-block;width:6px;height:6px;background:var(--green);border-radius:50%;margin-right:6px;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.header-right{display:flex;align-items:center;gap:14px}
.header-ts{font-family:var(--mono);font-size:11px;color:var(--subtle)}
.header-btn{font-family:var(--mono);font-size:11px;color:var(--subtle);border:1px solid var(--border);padding:3px 10px;border-radius:2px;cursor:pointer;background:none;transition:all .15s}
.header-btn:hover{border-color:var(--gold);color:var(--gold)}
.main{padding:28px;max-width:1440px;margin:0 auto}

/* Stats */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:28px}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
.stat{background:var(--bg);padding:18px 22px;position:relative}
.stat::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat:nth-child(1)::after{background:var(--gold)}
.stat:nth-child(2)::after{background:var(--blue)}
.stat:nth-child(3)::after{background:var(--green)}
.stat:nth-child(4)::after{background:var(--cyan)}
.stat:nth-child(5)::after{background:var(--purple)}
.stat-value{font-family:var(--mono);font-size:30px;font-weight:700;line-height:1;letter-spacing:-1px}
.stat-label{font-size:10px;color:var(--subtle);margin-top:8px;text-transform:uppercase;letter-spacing:1.2px;font-family:var(--mono)}

/* Tabs */
.tabs{display:flex;border-bottom:1px solid var(--border);margin-bottom:22px}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--subtle);cursor:pointer;padding:10px 20px;font-family:var(--mono);font-size:12px;transition:color .12s;margin-bottom:-1px;white-space:nowrap;outline:none}
.tab:hover{color:var(--muted)}
.tab.active{color:var(--gold);border-bottom-color:var(--gold)}
.tab.active::before{content:'› '}
.tab-content{display:none}.tab-content.active{display:block}

/* Toolbar */
.toolbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.search-input{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:2px;padding:7px 12px;font-family:var(--mono);font-size:12px;width:260px;outline:none;transition:border-color .12s}
.search-input:focus{border-color:var(--gold)}.search-input::placeholder{color:var(--subtle)}
.chip{background:transparent;border:1px solid var(--border);color:var(--subtle);border-radius:2px;padding:5px 10px;font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .12s}
.chip:hover{border-color:var(--border-hi);color:var(--muted)}
.chip.active{border-color:var(--gold);color:var(--gold)}
.count-badge{font-family:var(--mono);font-size:11px;color:var(--subtle);margin-left:auto}

/* Table */
.table-wrap{overflow-x:auto;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse}
th{background:var(--surface);color:var(--subtle);font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.9px;padding:9px 14px;text-align:left;border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--muted)}
th .si{opacity:.25;margin-left:4px}th.sorted .si{opacity:1;color:var(--gold)}
td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}

/* Badges */
.badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:11px;white-space:nowrap}
.badge::before{content:'●';font-size:7px;flex-shrink:0}
.badge-blue{color:var(--blue)}.badge-green{color:var(--green)}.badge-amber{color:var(--amber)}
.badge-red{color:var(--red)}.badge-purple{color:var(--purple)}.badge-gray{color:var(--muted)}
.ats-tag{font-family:var(--mono);font-size:10px;padding:2px 6px;background:var(--surface2);color:var(--subtle);border:1px solid var(--border);border-radius:2px}

/* Action buttons */
.action-btn{font-family:var(--mono);font-size:11px;padding:5px 12px;border-radius:2px;border:1px solid;cursor:pointer;transition:all .15s;background:transparent}
.btn-pipeline{border-color:var(--gold);color:var(--gold)}
.btn-pipeline:hover{background:var(--gold-bg)}
.btn-pipeline.added{border-color:var(--green);color:var(--green);cursor:default}
.btn-pipeline.dupe{border-color:var(--subtle);color:var(--subtle);cursor:default}
.btn-blue{border-color:var(--blue);color:var(--blue)}
.btn-blue:hover{background:var(--blue-bg)}
.btn-blue.loading{border-color:var(--subtle);color:var(--subtle);cursor:wait}
.btn-muted{border-color:var(--border);color:var(--muted)}
.btn-muted:hover{border-color:var(--border-hi);color:var(--text)}

/* Job cards */
.job-list-wrap{border:1px solid var(--border)}
.job-card{border-bottom:1px solid var(--border);padding:12px 16px;transition:background .1s;display:flex;gap:12px;align-items:flex-start}
.job-card:hover{background:var(--surface)}
.job-card:last-child{border-bottom:none}
.job-card.selected-card{background:var(--surface2);border-left:2px solid var(--gold)}

/* Checkbox */
.job-check{width:16px;height:16px;margin-top:3px;flex-shrink:0;accent-color:var(--gold);cursor:pointer}

.job-body{flex:1;min-width:0}
.job-card-top{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.job-title{font-weight:600;font-size:14px;flex:1;min-width:180px}
.job-company{color:var(--muted);font-size:13px;margin-top:1px}
.job-meta{display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}
.job-date{font-family:var(--mono);font-size:10px;color:var(--subtle)}
.job-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}

/* Keyword panel (per-job) */
.kw-panel{margin:10px 0 4px;padding:14px 16px;background:var(--surface2);border:1px solid var(--border-hi);border-left:2px solid var(--blue);display:none}
.kw-panel.visible{display:block}
.kw-panel-title{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:1.2px;color:var(--subtle);margin-bottom:10px;font-weight:600}
.kw-chips{display:flex;flex-wrap:wrap;gap:5px}
.kw-chip{font-family:var(--mono);font-size:11px;background:var(--surface);border:1px solid var(--border-hi);color:var(--muted);border-radius:2px;padding:2px 8px;cursor:pointer;transition:all .1s;user-select:none}
.kw-chip:hover{border-color:var(--gold);color:var(--text)}
.kw-chip.copied{border-color:var(--green);color:var(--green);background:var(--green-bg)}
.kw-chip.shared{border-color:var(--gold);color:var(--gold);background:var(--gold-bg)}
.kw-panel-note{font-family:var(--mono);font-size:10px;color:var(--subtle);margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
.kw-panel-error{color:var(--red);font-family:var(--mono);font-size:11px}

/* Score badge */
.score-badge{font-family:var(--mono);font-size:11px;font-weight:700;padding:2px 7px;border-radius:2px;flex-shrink:0;min-width:36px;text-align:center}
.score-hi{color:var(--green);border:1px solid var(--green);background:var(--green-bg)}
.score-ok{color:var(--blue);border:1px solid var(--blue);background:var(--blue-bg)}
.score-mid{color:var(--amber);border:1px solid var(--amber);background:var(--amber-bg)}
.score-lo{color:var(--red);border:1px solid var(--red);background:var(--red-bg)}

/* Scan controls */
.scan-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.scan-title{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--subtle)}

/* Empty state */
.empty{text-align:center;padding:56px 24px;color:var(--subtle)}
.empty-icon{font-size:24px;opacity:.35;display:block;margin-bottom:14px}
.empty p{font-family:var(--mono);font-size:12px;line-height:1.8;max-width:340px;margin:0 auto}
.empty code{color:var(--gold)}

/* Floating selection bar */
#sel-bar{position:fixed;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--border-hi);padding:12px 28px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;z-index:100;transform:translateY(100%);transition:transform .2s}
#sel-bar.visible{transform:translateY(0)}
.sel-bar-count{font-family:var(--mono);font-size:12px;color:var(--muted)}
.sel-bar-count strong{color:var(--text)}
.sel-bar-actions{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.sel-clear{font-family:var(--mono);font-size:11px;color:var(--subtle);background:none;border:none;cursor:pointer;padding:4px 8px}
.sel-clear:hover{color:var(--muted)}

/* Batch keyword results panel */
#batch-panel{margin-top:14px;padding:18px 20px;background:var(--surface);border:1px solid var(--border-hi);border-left:2px solid var(--gold);display:none}
#batch-panel.visible{display:block}
.batch-panel-title{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:1.2px;color:var(--subtle);margin-bottom:12px;font-weight:600}
.batch-legend{font-family:var(--mono);font-size:10px;color:var(--subtle);margin-top:10px;padding-top:8px;border-top:1px solid var(--border);display:flex;gap:16px;flex-wrap:wrap}
.batch-legend span{display:flex;align-items:center;gap:5px}
.dot-gold{display:inline-block;width:8px;height:8px;background:var(--gold);border-radius:50%}
.dot-blue{display:inline-block;width:8px;height:8px;background:var(--blue);border-radius:50%}

/* Toast */
#toast{position:fixed;bottom:70px;right:24px;background:var(--surface);border:1px solid var(--border-hi);color:var(--text);font-family:var(--mono);font-size:12px;padding:10px 16px;border-radius:2px;opacity:0;transform:translateY(6px);transition:all .2s;pointer-events:none;z-index:200;max-width:320px}
#toast.show{opacity:1;transform:translateY(0)}

@media(max-width:640px){.main{padding:16px}.stats{grid-template-columns:1fr 1fr}.tab{padding:9px 12px}}
</style>
</head>
<body>
<header class="header">
  <div class="wordmark">
    <span class="wordmark-app">career-ops</span>
    <span class="wordmark-sep">/</span>
    <span class="wordmark-sub"><span class="live-dot"></span>live</span>
  </div>
  <div class="header-right">
    <span class="header-ts">${ts}</span>
    <button class="header-btn" onclick="location.reload()">↺ refresh</button>
  </div>
</header>

<div class="main">
  <div class="stats" id="stats-row"></div>

  <nav class="tabs">
    <button class="tab active" data-tab="search">search</button>
    <button class="tab" data-tab="pipeline">pipeline <span id="tab-pipeline-count"></span></button>
    <button class="tab" data-tab="applications">applications <span id="tab-apps-count"></span></button>
  </nav>

  <!-- ── Search tab ── -->
  <div id="search" class="tab-content active">
    <div class="scan-header">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="scan-title" id="scan-count-label">job board results</span>
        <span id="score-note" style="font-family:var(--mono);font-size:10px;color:var(--subtle)"></span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="action-btn btn-pipeline" onclick="syncTopPipeline()" id="sync-btn" style="font-size:11px;padding:5px 14px" title="Replace pipeline.md with the top 100 scored jobs">⇅ sync top 100 → pipeline</button>
        <button class="action-btn btn-blue" onclick="runScan()" id="scan-btn" style="font-size:11px;padding:5px 14px">↺ run new scan</button>
      </div>
    </div>
    <div class="toolbar">
      <input class="search-input" id="job-search" placeholder="filter by title, company, location…" oninput="filterJobs()">
      <div id="ats-filters" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      <span class="count-badge" id="job-count-badge"></span>
    </div>

    <!-- Batch keyword results (shown after extracting for multiple selected jobs) -->
    <div id="batch-panel">
      <div class="batch-panel-title" id="batch-panel-title">resume keywords — extracted from selected jobs</div>
      <div class="kw-chips" id="batch-kw-chips"></div>
      <div class="batch-legend">
        <span><span class="dot-gold"></span> appears in 2+ selected jobs</span>
        <span><span class="dot-blue"></span> appears in 1 job</span>
      </div>
      <div class="kw-panel-note" id="batch-kw-note"></div>
    </div>

    <div class="job-list-wrap" id="job-list"></div>
  </div>

  <!-- ── Pipeline tab ── -->
  <div id="pipeline" class="tab-content">
    <div class="toolbar">
      <input class="search-input" id="pipeline-search" placeholder="filter by company or role" oninput="filterPipeline()">
      <span class="count-badge" id="pipeline-count-badge"></span>
    </div>
    <div class="table-wrap">
      <table id="pipeline-table">
        <thead><tr>
          <th onclick="sortTable('pipeline-table',0,this)">#<span class="si">↕</span></th>
          <th onclick="sortTable('pipeline-table',1,this)">company<span class="si">↕</span></th>
          <th onclick="sortTable('pipeline-table',2,this)">role<span class="si">↕</span></th>
          <th onclick="sortTable('pipeline-table',3,this)">ats<span class="si">↕</span></th>
          <th>link</th>
        </tr></thead>
        <tbody id="pipeline-body"></tbody>
      </table>
    </div>
  </div>

  <!-- ── Applications tab ── -->
  <div id="applications" class="tab-content">
    <div class="toolbar">
      <input class="search-input" id="apps-search" placeholder="filter by company or role" oninput="filterApps()">
      <span class="count-badge" id="apps-count-badge"></span>
    </div>
    <div class="table-wrap">
      <table id="apps-table">
        <thead><tr>
          <th onclick="sortTable('apps-table',0,this)">#<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',1,this)">company<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',2,this)">role<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',3,this)">status<span class="si">↕</span></th>
        </tr></thead>
        <tbody id="apps-body"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- Floating selection action bar -->
<div id="sel-bar">
  <span class="sel-bar-count"><strong id="sel-count">0</strong> jobs selected</span>
  <div class="sel-bar-actions">
    <button class="action-btn btn-blue" id="sel-extract-btn" onclick="extractSelected()">◈ extract keywords for selected</button>
    <button class="action-btn btn-pipeline" id="sel-pipeline-btn" onclick="addSelectedToPipeline()">+ add all to pipeline</button>
    <button class="sel-clear" onclick="clearSelection()">✕ clear</button>
  </div>
</div>

<div id="toast"></div>

<script>
const DATA = ${dataJson};

// ─── Utilities ───────────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function relTime(ts){if(!ts)return '';try{const d=new Date(ts),n=new Date(),dd=Math.floor((n-d)/86400000);if(dd<1)return 'today';if(dd<7)return dd+'d ago';if(dd<30)return Math.floor(dd/7)+'w ago';return Math.floor(dd/30)+'mo ago'}catch{return ts.slice(0,10)||''}}
function statusBadge(s){const l=(s||'').toLowerCase();let c='badge-gray';if(l.includes('interview'))c='badge-green';else if(l.includes('offer'))c='badge-purple';else if(l.includes('applied'))c='badge-blue';else if(l.includes('evaluated'))c='badge-amber';return \`<span class="badge \${c}">\${esc(s||'—')}</span>\`}

function toast(msg,type='ok'){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.style.borderColor=type==='err'?'var(--red)':type==='warn'?'var(--amber)':'var(--border-hi)';
  el.classList.add('show');clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'),3200);
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function renderStats(){
  const a=DATA.apps,interviews=a.filter(x=>/interview/i.test(x.status)).length;
  const applied=a.filter(x=>/applied|responded|interview|offer/i.test(x.status)).length;
  const cards=[
    {v:DATA.scanJobs.length,       l:'scanned',    c:'var(--gold)'},
    {v:DATA.pipeline.pending.length,l:'pipeline',   c:'var(--blue)'},
    {v:a.length,                   l:'evaluated',  c:'var(--green)'},
    {v:applied,                    l:'applied',    c:'var(--cyan)'},
    {v:interviews,                 l:'interviews', c:'var(--purple)'},
  ];
  document.getElementById('stats-row').innerHTML=cards.map((c,i)=>
    \`<div class="stat"><div class="stat-value" id="sv-\${i}" style="color:\${c.c}">\${c.v||0}</div><div class="stat-label">\${c.l}</div></div>\`
  ).join('');
  cards.forEach((c,i)=>{
    if(!c.v)return;
    const el=document.getElementById('sv-'+i),tgt=c.v,dur=420+i*60,t0=performance.now();
    const tick=ts=>{const p=Math.min((ts-t0)/dur,1),e=1-Math.pow(1-p,3);el.textContent=Math.round(tgt*e);if(p<1)requestAnimationFrame(tick);else el.textContent=tgt};
    requestAnimationFrame(tick);
  });
}

// ─── Selection state ─────────────────────────────────────────────────────────
const selected = new Set(); // set of original indices into allJobs
let visibleJobs = []; // current filtered view: [{origIdx, job}]

function toggleSelect(origIdx, cb) {
  if (selected.has(origIdx)) { selected.delete(origIdx); cb.checked=false; }
  else { selected.add(origIdx); cb.checked=true; }
  const card = document.getElementById('jc-'+origIdx);
  if (card) card.classList.toggle('selected-card', selected.has(origIdx));
  updateSelBar();
}

function updateSelBar() {
  const n = selected.size;
  const bar = document.getElementById('sel-bar');
  document.getElementById('sel-count').textContent = n;
  if (n > 0) bar.classList.add('visible'); else bar.classList.remove('visible');
}

function clearSelection() {
  selected.forEach(i => {
    const cb = document.getElementById('cb-'+i);
    if (cb) cb.checked = false;
    const card = document.getElementById('jc-'+i);
    if (card) card.classList.remove('selected-card');
  });
  selected.clear();
  updateSelBar();
  document.getElementById('batch-panel').classList.remove('visible');
}

// ─── Search / filter ─────────────────────────────────────────────────────────
let allJobs = DATA.scanJobs;
let activeAts = '';

function renderSearch() {
  const atsList = [...new Set(allJobs.map(j=>j.ats).filter(Boolean))].sort();
  document.getElementById('ats-filters').innerHTML =
    \`<button class="chip active" onclick="setAts('',this)">all</button>\` +
    atsList.map(a=>\`<button class="chip" onclick="setAts('\${esc(a)}',this)">\${esc(a)}</button>\`).join('');
  applyJobFilters();
}

function setAts(ats, btn) {
  activeAts = ats;
  document.querySelectorAll('#ats-filters .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  applyJobFilters();
}

function filterJobs() { applyJobFilters(); }

function applyJobFilters() {
  const q = document.getElementById('job-search').value.toLowerCase();
  visibleJobs = allJobs
    .map((j,i)=>({origIdx:i,job:j}))
    .filter(({job:j})=>{
      if (activeAts && j.ats !== activeAts) return false;
      if (q && !(j.title+j.company+j.location).toLowerCase().includes(q)) return false;
      return true;
    });
  renderJobList();
}

function scoreClass(s){return s>=70?'score-hi':s>=50?'score-ok':s>=35?'score-mid':'score-lo'}

function renderJobList() {
  const el = document.getElementById('job-list');
  const badge = document.getElementById('job-count-badge');
  const label = document.getElementById('scan-count-label');
  const scoreNote = document.getElementById('score-note');
  badge.textContent = visibleJobs.length+' job'+(visibleJobs.length!==1?'s':'');
  label.textContent = 'job board results ('+allJobs.length+' total, sorted by match score)';

  // Show score distribution hint
  if (allJobs.length > 0) {
    const avg = Math.round(allJobs.reduce((s,j)=>s+(j.score||0),0)/allJobs.length);
    const top = allJobs.filter(j=>(j.score||0)>=70).length;
    scoreNote.textContent = 'avg '+avg+' · '+top+' strong matches (≥70)';
  }

  if (!visibleJobs.length) {
    el.innerHTML = allJobs.length === 0
      ? \`<div class="empty"><span class="empty-icon">◈</span><p>no scan history yet.<br>click <strong style="color:var(--gold)">↺ run new scan</strong> above to search job boards,<br>or run <code>node scan.mjs</code> in terminal.</p></div>\`
      : \`<div class="empty"><span class="empty-icon">◈</span><p>no jobs match your filter</p></div>\`;
    return;
  }

  el.innerHTML = visibleJobs.map(({origIdx:idx, job:j}) => {
    const sc = j.score ?? 0;
    const scorePill = \`<span class="score-badge \${scoreClass(sc)}">\${sc}</span>\`;
    const ats = j.ats ? \`<span class="ats-tag">\${esc(j.ats)}</span>\` : '';
    const date = relTime(j.firstSeen);
    const loc = j.location ? \`<span style="font-family:var(--mono);font-size:10px;color:var(--subtle)">\${esc(j.location)}</span>\` : '';
    const pipeBtn = j.inPipeline
      ? \`<button class="action-btn btn-pipeline added" disabled>✓ in pipeline</button>\`
      : \`<button class="action-btn btn-pipeline" id="pb-\${idx}" onclick="addToPipeline(\${idx})">+ pipeline</button>\`;
    const isSelected = selected.has(idx);
    return \`<div class="job-card\${isSelected?' selected-card':''}" id="jc-\${idx}">
      <input type="checkbox" class="job-check" id="cb-\${idx}" \${isSelected?'checked':''} onchange="toggleSelect(\${idx},this)">
      <div class="job-body">
        <div class="job-card-top">
          <div style="flex:1;min-width:180px">
            <div class="job-title">\${esc(j.title||'Untitled')}</div>
            <div class="job-company">\${esc(j.company||'Unknown')}\${loc?'  ·  ':''}\${loc}</div>
          </div>
          <div class="job-meta">
            \${scorePill}
            \${ats}
            \${date?\`<span class="job-date">\${esc(date)}</span>\`:''}
          </div>
        </div>
        <div class="job-actions">
          \${pipeBtn}
          <button class="action-btn btn-blue" id="kb-\${idx}" onclick="extractJobKeywords(\${idx})">◈ keywords</button>
          <a href="\${esc(j.url)}" target="_blank" rel="noopener" class="action-btn btn-muted" style="text-decoration:none">↗ open</a>
        </div>
        <div class="kw-panel" id="kp-\${idx}">
          <div class="kw-panel-title">resume keywords — click to copy</div>
          <div class="kw-chips" id="kc-\${idx}"></div>
          <div class="kw-panel-note" id="kn-\${idx}"></div>
        </div>
      </div>
    </div>\`;
  }).join('');
}

// ─── Single-job keyword extraction ───────────────────────────────────────────
async function extractJobKeywords(idx) {
  const j = allJobs[idx];
  const btn = document.getElementById('kb-'+idx);
  const panel = document.getElementById('kp-'+idx);
  const chips = document.getElementById('kc-'+idx);
  const note = document.getElementById('kn-'+idx);
  if (!btn) return;
  if (panel.classList.contains('visible')) {
    panel.classList.remove('visible');
    btn.textContent = '◈ keywords';
    return;
  }
  btn.textContent = 'loading…'; btn.classList.add('loading'); btn.disabled = true;
  try {
    const r = await fetch('/api/keywords/extract', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:j.url})});
    const d = await r.json();
    btn.textContent = '◈ keywords'; btn.classList.remove('loading'); btn.disabled = false;
    if (d.error) { chips.innerHTML = \`<span class="kw-panel-error">\${esc(d.error)}</span>\`; note.textContent=''; panel.classList.add('visible'); return; }
    renderKwChips(chips, d.keywords, note, null);
    panel.classList.add('visible');
  } catch(e) { btn.textContent='◈ keywords'; btn.classList.remove('loading'); btn.disabled=false; toast('Extraction failed','err'); }
}

function renderKwChips(el, keywords, noteEl, freqMap) {
  if (!keywords.length) { el.innerHTML='<span style="color:var(--subtle);font-family:var(--mono);font-size:11px">no keywords found — page may require JavaScript to render</span>'; return; }
  el.innerHTML = keywords.map(k => {
    const cls = freqMap && freqMap[k.toLowerCase()]>1 ? 'kw-chip shared' : 'kw-chip';
    return \`<span class="\${cls}" onclick="copyKw(this,'\${esc(k)}')">\${esc(k)}</span>\`;
  }).join('');
  if (noteEl) noteEl.textContent = \`\${keywords.length} keywords — click any to copy\`;
}

function copyKw(el, text) {
  navigator.clipboard.writeText(text).then(()=>{ el.classList.add('copied'); toast('Copied: '+text); setTimeout(()=>el.classList.remove('copied'),1500); });
}

// ─── Batch keyword extraction (selected jobs) ─────────────────────────────────
async function extractSelected() {
  if (!selected.size) return;
  const btn = document.getElementById('sel-extract-btn');
  const panel = document.getElementById('batch-panel');
  const chips = document.getElementById('batch-kw-chips');
  const note = document.getElementById('batch-kw-note');
  const title = document.getElementById('batch-panel-title');

  btn.textContent = \`extracting \${selected.size} jobs…\`; btn.disabled = true;

  const urls = [...selected].map(i => ({ idx: i, url: allJobs[i].url }));
  try {
    const r = await fetch('/api/keywords/extract-batch', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ urls: urls.map(u=>u.url) }),
    });
    const d = await r.json();
    btn.textContent = '◈ extract keywords for selected'; btn.disabled = false;

    // Count keyword frequency across jobs
    const freqMap = {};
    for (const kws of Object.values(d.byUrl || {})) {
      for (const k of kws) { const key = k.toLowerCase(); freqMap[key] = (freqMap[key]||0)+1; }
    }

    // Sort: shared keywords first, then alphabetical
    const all = [...new Set(Object.keys(freqMap))];
    all.sort((a,b) => (freqMap[b]||0) - (freqMap[a]||0) || a.localeCompare(b));

    // Reconstruct display names
    const allByKey = {};
    for (const kws of Object.values(d.byUrl || {})) {
      for (const k of kws) allByKey[k.toLowerCase()] = k;
    }
    const display = all.map(k => allByKey[k] || k);

    title.textContent = \`resume keywords — \${selected.size} jobs, \${display.length} unique keywords\`;
    renderKwChips(chips, display, note, freqMap);
    if (d.errors && d.errors.length) note.textContent += \` (\${d.errors.length} URL(s) could not be fetched)\`;
    panel.classList.add('visible');
    panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
  } catch(e) {
    btn.textContent='◈ extract keywords for selected'; btn.disabled=false;
    toast('Batch extraction failed','err');
  }
}

// ─── Pipeline actions ─────────────────────────────────────────────────────────
async function addToPipeline(idx) {
  const j = allJobs[idx];
  const btn = document.getElementById('pb-'+idx);
  if (!btn) return;
  btn.textContent='adding…'; btn.disabled=true;
  try {
    const r = await fetch('/api/pipeline/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:j.url,company:j.company||'',role:j.title||''})});
    const d = await r.json();
    if (d.status==='added') { btn.textContent='✓ added'; btn.classList.add('added'); allJobs[idx].inPipeline=true; toast('Added '+( j.company||j.title)+' to pipeline'); }
    else if (d.status==='already_exists') { btn.textContent='already in pipeline'; btn.classList.add('dupe'); toast('Already in pipeline','warn'); }
  } catch(e) { btn.textContent='+ pipeline'; btn.disabled=false; toast('Failed','err'); }
}

async function addSelectedToPipeline() {
  if (!selected.size) return;
  const btn = document.getElementById('sel-pipeline-btn');
  btn.textContent='adding…'; btn.disabled=true;
  let added=0, dupes=0;
  for (const idx of selected) {
    const j = allJobs[idx];
    try {
      const r = await fetch('/api/pipeline/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:j.url,company:j.company||'',role:j.title||''})});
      const d = await r.json();
      if (d.status==='added') added++;
      else if (d.status==='already_exists') dupes++;
      allJobs[idx].inPipeline=true;
    } catch{}
  }
  btn.textContent='+ add all to pipeline'; btn.disabled=false;
  toast('Added '+added+' job'+(added!==1?'s':'')+' to pipeline'+(dupes>0?' ('+dupes+' already there)':''));
  clearSelection();
  applyJobFilters(); // refresh buttons
}

// ─── Sync top N → pipeline ────────────────────────────────────────────────────
async function syncTopPipeline() {
  if (!allJobs.length) { toast('No scan history — run a scan first','warn'); return; }
  const btn = document.getElementById('sync-btn');
  btn.textContent='syncing…'; btn.disabled=true;
  try {
    const r = await fetch('/api/pipeline/sync-top',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({n:100})});
    const d = await r.json();
    btn.textContent='⇅ sync top 100 → pipeline'; btn.disabled=false;
    if (d.error) { toast(d.error,'err'); return; }
    toast('Pipeline replaced: top '+d.synced+' jobs (scores '+d.topScore+'→'+d.cutoffScore+')');
    // Mark all jobs as inPipeline if in top 100
    const top100Urls = new Set(allJobs.slice(0,100).map(j=>j.url));
    allJobs.forEach(j=>{ j.inPipeline = top100Urls.has(j.url); });
    applyJobFilters();
  } catch(e) { btn.textContent='⇅ sync top 100 → pipeline'; btn.disabled=false; toast('Sync failed','err'); }
}

// ─── Scan ────────────────────────────────────────────────────────────────────
async function runScan() {
  const btn = document.getElementById('scan-btn');
  btn.textContent='starting…'; btn.disabled=true;
  try {
    const r = await fetch('/api/scan/run',{method:'POST'});
    const d = await r.json();
    if (d.status==='started') { btn.textContent='↺ scanning…'; toast('Scan started — refresh in ~30s when complete'); }
    else if (d.status==='already_running') { btn.textContent='↺ run new scan'; btn.disabled=false; toast('Scan already running','warn'); }
    else { btn.textContent='↺ run new scan'; btn.disabled=false; toast(d.error||'Could not start scan','err'); }
  } catch(e) { btn.textContent='↺ run new scan'; btn.disabled=false; toast('Failed to start scan','err'); }
}

// ─── Pipeline tab ─────────────────────────────────────────────────────────────
let pipelineRows = [];
function renderPipeline() {
  pipelineRows = DATA.pipeline.pending;
  document.getElementById('tab-pipeline-count').textContent = '('+pipelineRows.length+')';
  renderPipelineRows(pipelineRows);
}
function renderPipelineRows(items) {
  const tbody = document.getElementById('pipeline-body');
  document.getElementById('pipeline-count-badge').textContent = items.length+' job'+(items.length!==1?'s':'');
  if (!items.length) { tbody.innerHTML='<tr><td colspan="5"><div class="empty"><span class="empty-icon">📭</span><p>no pending jobs.<br>select jobs in the search tab and click <code>+ pipeline</code></p></div></td></tr>'; return; }
  tbody.innerHTML = items.map((j,i)=>\`<tr>
    <td style="color:var(--subtle);font-family:var(--mono);font-size:12px">\${i+1}</td>
    <td style="font-weight:600">\${esc(j.company)||'—'}</td>
    <td style="color:var(--muted)">\${esc(j.role)||'—'}</td>
    <td>\${j.ats?\`<span class="ats-tag">\${esc(j.ats)}</span>\`:'—'}</td>
    <td><a href="\${esc(j.url)}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:11px">open ↗</a></td>
  </tr>\`).join('');
}
function filterPipeline() { const q=document.getElementById('pipeline-search').value.toLowerCase(); renderPipelineRows(q?pipelineRows.filter(r=>(r.company+r.role).toLowerCase().includes(q)):pipelineRows); }

// ─── Applications tab ────────────────────────────────────────────────────────
let appsRows = [];
function renderApplications() {
  appsRows = DATA.apps;
  document.getElementById('tab-apps-count').textContent = '('+appsRows.length+')';
  renderAppsRows(appsRows);
}
function renderAppsRows(items) {
  const tbody = document.getElementById('apps-body');
  document.getElementById('apps-count-badge').textContent = items.length+' application'+(items.length!==1?'s':'');
  if (!items.length) { tbody.innerHTML='<tr><td colspan="4"><div class="empty"><span class="empty-icon">📋</span><p>no applications yet.<br>evaluate jobs with /career-ops</p></div></td></tr>'; return; }
  tbody.innerHTML = items.map((a,i)=>\`<tr>
    <td style="color:var(--subtle);font-family:var(--mono);font-size:12px">\${i+1}</td>
    <td style="font-weight:600">\${esc(a.company)}</td>
    <td style="color:var(--muted)">\${esc(a.role)}</td>
    <td>\${statusBadge(a.status)}</td>
  </tr>\`).join('');
}
function filterApps() { const q=document.getElementById('apps-search').value.toLowerCase(); renderAppsRows(q?appsRows.filter(r=>(r.company+r.role).toLowerCase().includes(q)):appsRows); }

// ─── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

function sortTable(id,col,th){
  const t=document.getElementById(id),tbody=t.querySelector('tbody'),rows=[...tbody.querySelectorAll('tr')];
  const asc=th.dataset.dir!=='asc';th.dataset.dir=asc?'asc':'desc';
  t.querySelectorAll('th').forEach(h=>{h.classList.remove('sorted');h.querySelector('.si').textContent='↕'});
  th.classList.add('sorted');th.querySelector('.si').textContent=asc?'↑':'↓';
  rows.sort((a,b)=>{const av=a.cells[col]?.textContent.trim()||'',bv=b.cells[col]?.textContent.trim()||'',an=parseFloat(av),bn=parseFloat(bv);if(!isNaN(an)&&!isNaN(bn))return asc?an-bn:bn-an;return asc?av.localeCompare(bv):bv.localeCompare(av)});
  rows.forEach(r=>tbody.appendChild(r));
}

// ─── Init ────────────────────────────────────────────────────────────────────
renderStats();
renderSearch();
renderPipeline();
renderApplications();
</script>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

let scanProcess = null;

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // ── GET / ──
  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPage());
    return;
  }

  // ── POST /api/pipeline/add ──
  if (method === 'POST' && url === '/api/pipeline/add') {
    const body = await readBody(req);
    if (!body.url) return json(res, { error: 'url required' }, 400);
    return json(res, { status: addToPipeline(body.url, body.company || '', body.role || '') });
  }

  // ── POST /api/keywords/extract (single URL) ──
  if (method === 'POST' && url === '/api/keywords/extract') {
    const body = await readBody(req);
    if (!body.url) return json(res, { error: 'url required' }, 400);
    return json(res, await extractFromUrl(body.url));
  }

  // ── POST /api/keywords/extract-batch (multiple URLs in parallel) ──
  if (method === 'POST' && url === '/api/keywords/extract-batch') {
    const body = await readBody(req);
    const urls = Array.isArray(body.urls) ? body.urls.slice(0, 20) : [];
    if (!urls.length) return json(res, { byUrl: {}, errors: [] }, 400);

    const results = await Promise.all(urls.map(async u => {
      const r = await extractFromUrl(u);
      return { url: u, keywords: r.keywords || [], error: r.error };
    }));

    const byUrl = {};
    const errors = [];
    for (const r of results) {
      if (r.error) errors.push({ url: r.url, error: r.error });
      byUrl[r.url] = r.keywords;
    }
    return json(res, { byUrl, errors });
  }

  // ── POST /api/pipeline/sync-top ──
  if (method === 'POST' && url === '/api/pipeline/sync-top') {
    const body = await readBody(req);
    const n = Math.min(Math.max(1, parseInt(body.n || '100', 10)), 500);
    const result = syncTopToPipeline(n, ROOT);
    return json(res, result.error ? { error: result.error } : result, result.error ? 400 : 200);
  }

  // ── POST /api/scan/run ──
  if (method === 'POST' && url === '/api/scan/run') {
    // Auto-bootstrap portals.yml from example template if missing
    if (!ensurePortals()) {
      return json(res, { error: 'portals.yml not found and no template available. Create portals.yml manually.' }, 400);
    }
    if (scanProcess && scanProcess.exitCode === null) {
      return json(res, { status: 'already_running' });
    }
    scanProcess = spawn('node', ['scan.mjs'], { cwd: ROOT, detached: false });
    scanProcess.on('error', e => console.error('[scan]', e.message));
    scanProcess.stdout?.on('data', d => process.stdout.write(`[scan] ${d}`));
    scanProcess.stderr?.on('data', d => process.stderr.write(`[scan] ${d}`));
    return json(res, { status: 'started' });
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n  career-ops dashboard  →  http://localhost:${PORT}\n`);
  console.log(`  Search tab: browse scanned jobs, select multiple, extract keywords, add to pipeline`);
  console.log(`  "Run new scan" auto-configures portals.yml if needed, then scans job boards`);
  console.log(`  Press Ctrl+C to stop\n`);
});
