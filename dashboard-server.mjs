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

const TECH_RE = /\b(Python|JavaScript|TypeScript|SQL|R(?=[\s,.]|$)|Go(?=[\s,.]|$)|Java(?!Script)|Scala|Rust|C\+\+|React|Node\.?js|Docker|Kubernetes|K8s|AWS|GCP|Azure|Spark|Kafka|Airflow|dbt|Tableau|Power\s*BI|TensorFlow|PyTorch|scikit.learn|NLP|LLM|RAG|API|ETL|CI\/CD|Git|PostgreSQL|Postgres|MongoDB|Redis|Snowflake|BigQuery|Databricks|MLflow|Grafana|FastAPI|Django|Flask|vector\s+(?:search|DB|database|store)|embeddings|LangChain|OpenAI|transformer|BERT|GPT|fine.tun\w*|prompt\s+engineer\w*|agentic|multi.agent|orchestration|feature\s+store|data\s+warehouse|data\s+lake|microservices|REST|GraphQL|Terraform|Helm|A\/B\s+testing|experimentation|machine\s+learning|deep\s+learning|computer\s+vision|recommendation|time\s+series|reinforcement\s+learning|statistics|hypothesis\s+test\w*|causal\s+\w+|observability|monitoring|inference|evaluation|Looker|Mixpanel|DuckDB|Polars|Pandas|NumPy|Matplotlib|Seaborn|Plotly|Streamlit|HuggingFace|Hugging\s+Face|RLHF|HITL|Redshift|Hive|Presto|Trino|dbt|dbt\s+Core|Fivetran|Stitch|Segment|Amplitude|Heap|Braze|Salesforce|Tableau|Sigma|Mode|Hex|Jupyter|VS\s*Code|Airflow|Prefect|Dagster|Great\s+Expectations|Monte\s+Carlo|Soda|Elementary|PowerBI|Power\s+BI)\b/gi;

const ROLE_RE = /\b(data\s+modeling|data\s+pipeline|data\s+quality|data\s+governance|data\s+catalog|business\s+intelligence|self.serve\s+analytics|real.time\s+analytics|batch\s+processing|stream\s+processing|A\/B\s+testing|causal\s+inference|predictive\s+modeling|anomaly\s+detection|root\s+cause\s+analysis|SQL\s+optimization|dimensional\s+modeling|star\s+schema|feature\s+engineering|model\s+deployment|analytics\s+engineering|data\s+visualization|cross.functional|stakeholder\s+management|product\s+analytics|growth\s+analytics|marketing\s+analytics|financial\s+modeling|data\s+driven|insight[s]?\s+generation|reporting\s+automation|KPI\s+tracking|metric\s+definition|experiment\s+design|statistical\s+significance|regression\s+analysis|time\s+series\s+forecasting)\b/gi;

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
  if (!raw) return { keywords: [], error: 'Could not reach page. Check the URL is public.' };
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 100) return { keywords: [], error: 'Page appears to be JavaScript-rendered. Try copying the JD text instead.' };
  const keywords = extractKeywords(text.slice(0, 60000));
  return { keywords, chars: text.length };
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
  return jobs.slice(-800).reverse(); // newest first, cap at 800
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
    const checked = m[1] === 'x';
    const rest = m[2].replace(/~~([^~]+)~~/g, '$1').trim();
    const parts = rest.split(' | ');
    const entry = { url: parts[0].trim(), company: parts[1]?.trim() || '', role: parts[2]?.trim() || '', ats: detectATS(parts[0]) };
    if (section === 'pending' && !checked) pending.push(entry);
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

// ─── HTML page ────────────────────────────────────────────────────────────────

function buildPage() {
  const scanJobs = parseScanHistory(ROOT);
  const pipelineUrls = getPipelineUrls(ROOT);
  const pipeline = parsePipeline(ROOT);
  const apps = parseApplications(ROOT);
  const ts = new Date().toLocaleString();
  const hasPortals = fs.existsSync(path.join(ROOT, 'portals.yml'));

  // Mark jobs that are already in pipeline or evaluated
  const enriched = scanJobs.map(j => ({
    ...j,
    inPipeline: pipelineUrls.has(j.url),
    inApps: apps.some(a => j.title && a.role && j.title.toLowerCase().includes(a.role.toLowerCase().split(' ')[0])),
  }));

  const dataJson = JSON.stringify({
    scanJobs: enriched,
    pipeline,
    apps,
    hasPortals,
    generated: new Date().toISOString(),
  });

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
a{color:var(--gold);text-decoration:none}a:hover{color:var(--text);text-decoration:underline}

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
.search{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:2px;padding:7px 12px;font-family:var(--mono);font-size:12px;width:240px;outline:none;transition:border-color .12s}
.search:focus{border-color:var(--gold)}.search::placeholder{color:var(--subtle)}
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
td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text)}
tr:last-child td{border-bottom:none}

/* Badges + scores */
.badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:11px;white-space:nowrap}
.badge::before{content:'●';font-size:7px;flex-shrink:0}
.badge-blue{color:var(--blue)}.badge-green{color:var(--green)}.badge-amber{color:var(--amber)}
.badge-red{color:var(--red)}.badge-purple{color:var(--purple)}.badge-cyan{color:var(--cyan)}
.badge-gray{color:var(--muted)}
.score{font-family:var(--mono);font-size:13px;font-weight:700}
.score-hi{color:var(--green)}.score-ok{color:var(--blue)}.score-mid{color:var(--amber)}.score-lo{color:var(--red)}
.ats-tag{font-family:var(--mono);font-size:10px;padding:2px 6px;background:var(--surface2);color:var(--subtle);border:1px solid var(--border);border-radius:2px}

/* Search-specific: job cards */
.job-card{border-bottom:1px solid var(--border);padding:12px 16px;transition:background .1s}
.job-card:hover{background:var(--surface)}
.job-card:last-child{border-bottom:none}
.job-card-top{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.job-title{font-weight:600;font-size:14px;flex:1;min-width:200px}
.job-company{color:var(--muted);font-size:13px;margin-top:1px}
.job-meta{display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}
.job-date{font-family:var(--mono);font-size:10px;color:var(--subtle)}
.job-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.action-btn{font-family:var(--mono);font-size:11px;padding:5px 12px;border-radius:2px;border:1px solid;cursor:pointer;transition:all .15s;background:transparent}
.btn-pipeline{border-color:var(--gold);color:var(--gold)}
.btn-pipeline:hover{background:var(--gold-bg)}
.btn-pipeline.added{border-color:var(--green);color:var(--green);cursor:default}
.btn-pipeline.dupe{border-color:var(--subtle);color:var(--subtle);cursor:default}
.btn-keywords{border-color:var(--blue);color:var(--blue)}
.btn-keywords:hover{background:var(--blue-bg)}
.btn-keywords.loading{border-color:var(--subtle);color:var(--subtle);cursor:wait}
.btn-open{border-color:var(--border);color:var(--muted)}
.btn-open:hover{border-color:var(--border-hi);color:var(--text)}

/* Keyword result panel */
.kw-panel{margin:10px 0 4px;padding:14px 16px;background:var(--surface2);border:1px solid var(--border-hi);border-left:2px solid var(--blue);border-radius:0 2px 2px 0;display:none}
.kw-panel.visible{display:block}
.kw-panel-title{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:1.2px;color:var(--subtle);margin-bottom:10px;font-weight:600}
.kw-chips{display:flex;flex-wrap:wrap;gap:5px}
.kw-chip{font-family:var(--mono);font-size:11px;background:var(--surface);border:1px solid var(--border-hi);color:var(--muted);border-radius:2px;padding:2px 8px;cursor:pointer;transition:all .1s;user-select:none}
.kw-chip:hover{border-color:var(--gold);color:var(--text)}
.kw-chip.selected{border-color:var(--gold);color:var(--gold);background:var(--gold-bg)}
.kw-panel-note{font-family:var(--mono);font-size:10px;color:var(--subtle);margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
.kw-panel-error{color:var(--red);font-family:var(--mono);font-size:11px}

/* Manual URL extractor */
.url-extractor{background:var(--surface);border:1px solid var(--border);padding:18px 20px;margin-bottom:20px}
.url-extractor-title{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--subtle);margin-bottom:12px}
.url-row{display:flex;gap:8px;flex-wrap:wrap}
.url-input{flex:1;min-width:260px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:2px;padding:8px 12px;font-family:var(--mono);font-size:12px;outline:none;transition:border-color .12s}
.url-input:focus{border-color:var(--gold)}.url-input::placeholder{color:var(--subtle)}

/* Scan controls */
.scan-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.scan-title{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--subtle)}
.scan-status{font-family:var(--mono);font-size:11px;padding:4px 10px;border-radius:2px;border:1px solid var(--border)}
.scan-status.running{border-color:var(--amber);color:var(--amber)}
.scan-status.done{border-color:var(--green);color:var(--green)}

/* Empty */
.empty{text-align:center;padding:56px 24px;color:var(--subtle)}
.empty-icon{font-size:24px;opacity:.35;display:block;margin-bottom:14px}
.empty p{font-family:var(--mono);font-size:12px;line-height:1.8;max-width:320px;margin:0 auto}
.empty code{color:var(--gold)}

/* Toast */
#toast{position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--border-hi);color:var(--text);font-family:var(--mono);font-size:12px;padding:10px 16px;border-radius:2px;opacity:0;transform:translateY(6px);transition:all .2s;pointer-events:none;z-index:999;max-width:320px}
#toast.show{opacity:1;transform:translateY(0)}

/* detail panel for apps tab */
.detail-panel{padding:18px 22px;display:grid;gap:16px;border-top:2px solid var(--border-hi)}
.detail-section h4{font-family:var(--mono);font-size:9px;color:var(--subtle);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;font-weight:600}
.kw-list{display:flex;flex-wrap:wrap;gap:5px}
.kw{font-family:var(--mono);background:var(--surface2);border:1px solid var(--border-hi);color:var(--muted);border-radius:2px;padding:2px 7px;font-size:11px}
.tldr{color:var(--muted);font-size:13px;line-height:1.65;border-left:2px solid var(--border-hi);padding-left:14px}
.cv-changes{display:grid;gap:6px}
.cv-change{border-left:2px solid var(--gold);padding:7px 12px}
.section-label{font-family:var(--mono);font-size:9px;color:var(--gold);font-weight:700;letter-spacing:.9px;text-transform:uppercase;margin-bottom:3px}
.change-text{font-size:13px;color:var(--text);line-height:1.45}
.why-text{font-size:11px;color:var(--subtle);margin-top:3px}
.gap-item{display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)}
.gap-item:last-child{border-bottom:none}
.sev{font-family:var(--mono);font-size:9px;padding:2px 5px;border-radius:2px;flex-shrink:0;font-weight:700;margin-top:2px;text-transform:uppercase}
.sev-high{background:var(--red-bg);color:var(--red);border:1px solid var(--red)}
.sev-med{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber)}
.sev-low{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue)}
.kw-freq-list{display:grid;gap:5px}
.kw-freq-item{display:flex;align-items:center;gap:10px}
.kw-freq-name{width:180px;font-family:var(--mono);font-size:11px;color:var(--muted);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kw-freq-bar-wrap{flex:1;background:var(--surface2);height:3px}
.kw-freq-bar{height:100%;background:var(--gold);opacity:.6}
.kw-freq-count{font-family:var(--mono);font-size:11px;color:var(--subtle);width:24px;text-align:right;flex-shrink:0}
.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.chart-card{background:var(--surface);border:1px solid var(--border);padding:20px 22px}
.chart-card h3{font-family:var(--mono);font-size:10px;color:var(--subtle);text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.funnel{display:flex;flex-direction:column;gap:6px}
.funnel-row{display:flex;align-items:center;gap:10px}
.funnel-label{width:76px;font-family:var(--mono);font-size:10px;color:var(--subtle);flex-shrink:0}
.funnel-bar-wrap{flex:1;background:var(--surface2);height:18px}
.funnel-bar{height:100%;display:flex;align-items:center;padding-left:8px;font-family:var(--mono);font-size:10px;font-weight:700;min-width:28px}
.funnel-pct{width:30px;font-family:var(--mono);font-size:10px;color:var(--subtle);text-align:right;flex-shrink:0}
.score-dist{display:flex;flex-direction:column;gap:6px}
.score-row{display:flex;align-items:center;gap:10px}
.score-label{width:52px;font-family:var(--mono);font-size:10px;color:var(--subtle);flex-shrink:0}
.score-bar-wrap{flex:1;background:var(--surface2);height:18px}
.score-bar{height:100%;display:flex;align-items:center;padding-left:6px;font-family:var(--mono);font-size:10px;font-weight:700;min-width:22px}
.score-count{width:22px;font-family:var(--mono);font-size:10px;color:var(--subtle);text-align:right}
.status-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)}
.status-row:last-child{border-bottom:none}
.status-count{font-family:var(--mono);font-size:12px;font-weight:700}
.weekly{display:flex;align-items:flex-end;gap:6px;height:80px}
.week-col{display:flex;flex-direction:column;align-items:center;flex:1;gap:4px}
.week-bar{width:100%;background:var(--gold);opacity:.55;min-height:2px;border-radius:1px 1px 0 0}
.week-label{font-family:var(--mono);font-size:9px;color:var(--subtle);writing-mode:vertical-rl;transform:rotate(180deg);height:32px;display:flex;align-items:center}
tr.expandable{cursor:pointer}
tr.expandable:hover td{background:var(--surface)}
tr.detail-row td{background:var(--surface);padding:0;border-bottom:2px solid var(--border-hi)}
tr.detail-row.hidden{display:none}
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
    <button class="tab" data-tab="keywords">keywords</button>
    <button class="tab" data-tab="charts">charts</button>
  </nav>

  <!-- ── Search tab ── -->
  <div id="search" class="tab-content active">

    <!-- Manual URL extractor -->
    <div class="url-extractor">
      <div class="url-extractor-title">extract resume keywords from any job url or paste description text</div>
      <div class="url-row">
        <input class="url-input" id="manual-url" placeholder="https://jobs.example.com/… or paste job description text here" oninput="onManualInput()">
        <button class="action-btn btn-keywords" id="manual-extract-btn" onclick="manualExtract()">◈ extract keywords</button>
        <button class="action-btn btn-pipeline" id="manual-pipeline-btn" style="display:none" onclick="manualAddPipeline()">+ pipeline</button>
      </div>
      <div class="kw-panel" id="manual-kw-panel">
        <div class="kw-panel-title">keywords found — click to copy to clipboard</div>
        <div class="kw-chips" id="manual-kw-chips"></div>
        <div class="kw-panel-note" id="manual-kw-note"></div>
      </div>
    </div>

    <!-- Scan history browser -->
    <div class="scan-header">
      <span class="scan-title" id="scan-count-label">scanned jobs</span>
      <button class="action-btn btn-keywords" onclick="runScan()" id="scan-btn" style="font-size:11px;padding:5px 12px">↺ run new scan</button>
    </div>
    <div class="toolbar">
      <input class="search" id="job-search" placeholder="filter by title, company, skill…" oninput="filterJobs()">
      <div id="ats-filters" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      <span class="count-badge" id="job-count-badge"></span>
    </div>
    <div id="job-list" style="border:1px solid var(--border)"></div>
  </div>

  <!-- ── Pipeline tab ── -->
  <div id="pipeline" class="tab-content">
    <div class="toolbar">
      <input class="search" id="pipeline-search" placeholder="filter by company or role" oninput="filterPipeline()">
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
      <input class="search" id="apps-search" placeholder="filter by company or role" oninput="filterApps()">
      <div id="status-filters" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      <span class="count-badge" id="apps-count-badge"></span>
    </div>
    <div class="table-wrap">
      <table id="apps-table">
        <thead><tr>
          <th onclick="sortTable('apps-table',0,this)">#<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',1,this)">date<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',2,this)">company<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',3,this)">role<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',4,this)">score<span class="si">↕</span></th>
          <th onclick="sortTable('apps-table',5,this)">status<span class="si">↕</span></th>
          <th>pdf</th><th>report</th>
        </tr></thead>
        <tbody id="apps-body"></tbody>
      </table>
    </div>
  </div>

  <!-- ── Keywords tab ── -->
  <div id="keywords" class="tab-content"><div id="kw-content"></div></div>

  <!-- ── Charts tab ── -->
  <div id="charts" class="tab-content"><div class="charts-grid" id="charts-content"></div></div>
</div>

<div id="toast"></div>

<script>
const DATA = ${dataJson};

// ─── Utilities ──────────────────────────────────────────────────────────────
function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function statusBadge(s){const l=(s||'').toLowerCase();let c='badge-gray';if(l.includes('interview'))c='badge-green';else if(l.includes('offer'))c='badge-purple';else if(l.includes('applied'))c='badge-blue';else if(l.includes('evaluated'))c='badge-amber';else if(l.includes('responded'))c='badge-cyan';else if(l.includes('rejected')||l.includes('discarded')||l==='skip')c='badge-gray';return \`<span class="badge \${c}">\${esc(s||'—')}</span>\`}
function scorePill(sc){if(!sc)return \`<span style="color:var(--subtle);font-family:var(--mono)">—</span>\`;const c=sc>=4.5?'score-hi':sc>=4?'score-ok':sc>=3.5?'score-mid':'score-lo';return \`<span class="score \${c}">\${sc.toFixed(1)}</span>\`}
function sevClass(s){const l=(s||'').toLowerCase();if(l.includes('high')||l.includes('hard'))return 'sev-high';if(l.includes('med'))return 'sev-med';return 'sev-low'}
function relTime(ts){if(!ts)return '';try{const d=new Date(ts),n=new Date(),diff=Math.floor((n-d)/86400000);if(diff<1)return 'today';if(diff<7)return \`\${diff}d ago\`;if(diff<30)return \`\${Math.floor(diff/7)}w ago\`;return \`\${Math.floor(diff/30)}mo ago\`}catch{return ts.slice(0,10)||''}}

function toast(msg, type='ok'){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.style.borderColor = type==='err' ? 'var(--red)' : type==='warn' ? 'var(--amber)' : 'var(--border-hi)';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'),3000);
}

// ─── Stats ──────────────────────────────────────────────────────────────────
function renderStats(){
  const a=DATA.apps,sc=a.filter(x=>x.score>0),avg=sc.length?sc.reduce((s,x)=>s+x.score,0)/sc.length:null;
  const applied=a.filter(x=>/applied|responded|interview|offer/i.test(x.status)).length;
  const interviews=a.filter(x=>/interview/i.test(x.status)).length;
  const cards=[
    {v:DATA.scanJobs.length,  l:'scanned',   c:'var(--gold)'},
    {v:DATA.pipeline.pending.length, l:'pipeline', c:'var(--blue)'},
    {v:a.length,              l:'evaluated', c:'var(--green)'},
    {v:avg,                   l:'avg score', c:avg>=4?'var(--green)':avg?'var(--amber)':'var(--subtle)'},
    {v:interviews,            l:'interviews',c:'var(--purple)'},
  ];
  document.getElementById('stats-row').innerHTML=cards.map((c,i)=>{
    const disp=c.v===null?'—':typeof c.v==='number'&&!Number.isInteger(c.v)?c.v.toFixed(1):String(c.v||0);
    return \`<div class="stat"><div class="stat-value" id="sv-\${i}" style="color:\${c.c}">\${disp}</div><div class="stat-label">\${c.l}</div></div>\`;
  }).join('');
  cards.forEach((c,i)=>{
    if(!c.v)return;
    const el=document.getElementById(\`sv-\${i}\`),tgt=c.v,isInt=Number.isInteger(tgt);
    const dur=420+i*60,t0=performance.now();
    const tick=ts=>{const p=Math.min((ts-t0)/dur,1),e=1-Math.pow(1-p,3);el.textContent=isInt?String(Math.round(tgt*e)):(tgt*e).toFixed(1);if(p<1)requestAnimationFrame(tick);else el.textContent=isInt?String(tgt):tgt.toFixed(1)};
    requestAnimationFrame(tick);
  });
}

// ─── Search tab ─────────────────────────────────────────────────────────────
let allJobs=DATA.scanJobs;
let activeAts='';

function renderSearch(){
  const atsList=[...new Set(allJobs.map(j=>j.ats).filter(Boolean))].sort();
  document.getElementById('ats-filters').innerHTML=
    \`<button class="chip active" onclick="setAts('',this)">all</button>\`+
    atsList.map(a=>\`<button class="chip" onclick="setAts('\${esc(a)}',this)">\${esc(a)}</button>\`).join('');
  renderJobList(allJobs);
}

function setAts(ats,btn){
  activeAts=ats;
  document.querySelectorAll('#ats-filters .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  applyJobFilters();
}

function filterJobs(){applyJobFilters()}

function applyJobFilters(){
  const q=document.getElementById('job-search').value.toLowerCase();
  let jobs=allJobs;
  if(activeAts)jobs=jobs.filter(j=>j.ats===activeAts);
  if(q)jobs=jobs.filter(j=>(j.title+j.company+j.location).toLowerCase().includes(q));
  renderJobList(jobs);
}

function renderJobList(jobs){
  const el=document.getElementById('job-list');
  const badge=document.getElementById('job-count-badge');
  const label=document.getElementById('scan-count-label');
  badge.textContent=\`\${jobs.length} job\${jobs.length!==1?'s':''}\`;
  label.textContent=\`scanned jobs (\${allJobs.length} total)\`;

  if(!jobs.length){
    el.innerHTML=allJobs.length===0
      ? \`<div class="empty"><span class="empty-icon">◈</span><p>no scan history yet.<br>run <code>node scan.mjs</code> to discover jobs<br>from your configured portals.</p></div>\`
      : \`<div class="empty"><span class="empty-icon">◈</span><p>no jobs match your filter</p></div>\`;
    return;
  }

  el.innerHTML=jobs.map((j,idx)=>{
    const ats=j.ats?\`<span class="ats-tag">\${esc(j.ats)}</span>\`:'';
    const date=relTime(j.firstSeen);
    const loc=j.location?\`<span style="font-family:var(--mono);font-size:10px;color:var(--subtle)">\${esc(j.location)}</span>\`:'';
    const pipeBtn=j.inPipeline
      ? \`<button class="action-btn btn-pipeline added" disabled>✓ in pipeline</button>\`
      : \`<button class="action-btn btn-pipeline" id="pb-\${idx}" onclick="addToPipeline(\${idx})">+ pipeline</button>\`;
    return \`<div class="job-card" id="jc-\${idx}">
      <div class="job-card-top">
        <div style="flex:1;min-width:180px">
          <div class="job-title">\${esc(j.title||'Untitled')}</div>
          <div class="job-company">\${esc(j.company||'Unknown')}\${loc?'  ·  ':''}\${loc}</div>
        </div>
        <div class="job-meta">
          \${ats}
          \${date?\`<span class="job-date">\${esc(date)}</span>\`:''}
        </div>
      </div>
      <div class="job-actions">
        \${pipeBtn}
        <button class="action-btn btn-keywords" id="kb-\${idx}" onclick="extractJobKeywords(\${idx})">◈ extract keywords</button>
        <a href="\${esc(j.url)}" target="_blank" rel="noopener" class="action-btn btn-open" style="text-decoration:none">↗ open</a>
      </div>
      <div class="kw-panel" id="kp-\${idx}">
        <div class="kw-panel-title">resume keywords — click to copy</div>
        <div class="kw-chips" id="kc-\${idx}"></div>
        <div class="kw-panel-note" id="kn-\${idx}"></div>
      </div>
    </div>\`;
  }).join('');
}

async function addToPipeline(idx){
  const j=allJobs[idx];
  const btn=document.getElementById(\`pb-\${idx}\`);
  if(!btn)return;
  btn.textContent='adding…';btn.disabled=true;
  try{
    const r=await fetch('/api/pipeline/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:j.url,company:j.company||'',role:j.title||''})});
    const d=await r.json();
    if(d.status==='added'){
      btn.textContent='✓ added';btn.classList.add('added');
      toast(\`Added \${j.company||j.title} to pipeline\`);
      allJobs[idx].inPipeline=true;
    } else if(d.status==='already_exists'){
      btn.textContent='already in pipeline';btn.classList.add('dupe');
      toast('Already in pipeline','warn');
    }
  }catch(e){btn.textContent='+ pipeline';btn.disabled=false;toast('Failed to add','err')}
}

async function extractJobKeywords(idx){
  const j=allJobs[idx];
  const btn=document.getElementById(\`kb-\${idx}\`);
  const panel=document.getElementById(\`kp-\${idx}\`);
  const chips=document.getElementById(\`kc-\${idx}\`);
  const note=document.getElementById(\`kn-\${idx}\`);
  if(!btn)return;
  // Toggle if already shown
  if(panel.classList.contains('visible')){panel.classList.remove('visible');btn.textContent='◈ extract keywords';return}
  btn.textContent='loading…';btn.classList.add('loading');btn.disabled=true;
  try{
    const r=await fetch('/api/keywords/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:j.url})});
    const d=await r.json();
    btn.textContent='◈ keywords';btn.classList.remove('loading');btn.disabled=false;
    if(d.error){chips.innerHTML=\`<span class="kw-panel-error">\${esc(d.error)}</span>\`;note.textContent='';panel.classList.add('visible');return}
    renderKwChips(chips,d.keywords,note);
    panel.classList.add('visible');
  }catch(e){btn.textContent='◈ extract keywords';btn.classList.remove('loading');btn.disabled=false;toast('Extraction failed','err')}
}

function renderKwChips(el,keywords,noteEl){
  if(!keywords.length){el.innerHTML='<span style="color:var(--subtle);font-family:var(--mono);font-size:11px">no tech keywords found — the page may require JavaScript to render</span>';return}
  el.innerHTML=keywords.map(k=>\`<span class="kw-chip" onclick="copyKw(this,'\${esc(k)}')">\${esc(k)}</span>\`).join('');
  if(noteEl)noteEl.textContent=\`\${keywords.length} keywords — click any to copy to clipboard\`;
}

function copyKw(el,text){
  navigator.clipboard.writeText(text).then(()=>{el.classList.add('selected');toast(\`Copied: \${text}\`)});
}

// Manual URL / text extractor
let manualUrl='';
function onManualInput(){
  const v=document.getElementById('manual-url').value.trim();
  manualUrl=v;
  const pipeBtn=document.getElementById('manual-pipeline-btn');
  pipeBtn.style.display=(v.startsWith('http')?'':'none');
}

async function manualExtract(){
  const v=document.getElementById('manual-url').value.trim();
  if(!v)return;
  const btn=document.getElementById('manual-extract-btn');
  const panel=document.getElementById('manual-kw-panel');
  const chips=document.getElementById('manual-kw-chips');
  const note=document.getElementById('manual-kw-note');
  btn.textContent='loading…';btn.disabled=true;
  try{
    const body=v.startsWith('http')?{url:v}:{text:v};
    const r=await fetch('/api/keywords/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    btn.textContent='◈ extract keywords';btn.disabled=false;
    if(d.error){chips.innerHTML=\`<span class="kw-panel-error">\${esc(d.error)}</span>\`;note.textContent='';panel.classList.add('visible');return}
    renderKwChips(chips,d.keywords,note);
    panel.classList.add('visible');
  }catch(e){btn.textContent='◈ extract keywords';btn.disabled=false;toast('Extraction failed','err')}
}

async function manualAddPipeline(){
  const v=document.getElementById('manual-url').value.trim();
  if(!v.startsWith('http'))return;
  const btn=document.getElementById('manual-pipeline-btn');
  btn.textContent='adding…';btn.disabled=true;
  try{
    const r=await fetch('/api/pipeline/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:v,company:'',role:''})});
    const d=await r.json();
    if(d.status==='added'){btn.textContent='✓ added';toast('Added to pipeline')}
    else if(d.status==='already_exists'){btn.textContent='already in pipeline';toast('Already in pipeline','warn')}
  }catch(e){btn.textContent='+ pipeline';btn.disabled=false;toast('Failed','err')}
}

async function runScan(){
  const btn=document.getElementById('scan-btn');
  if(!DATA.hasPortals){toast('portals.yml not found — run /career-ops to set up first','warn');return}
  btn.textContent='starting…';btn.disabled=true;
  try{
    const r=await fetch('/api/scan/run',{method:'POST'});
    const d=await r.json();
    if(d.status==='started'){btn.textContent='↺ running…';toast('Scan started — refresh in ~30s when complete')}
    else{btn.textContent='↺ run new scan';btn.disabled=false;toast(d.error||'Could not start scan','err')}
  }catch(e){btn.textContent='↺ run new scan';btn.disabled=false;toast('Failed to start scan','err')}
}

// ─── Pipeline tab ────────────────────────────────────────────────────────────
let pipelineRows=[];
function renderPipeline(){
  const items=DATA.pipeline.pending;
  pipelineRows=items;
  document.getElementById('tab-pipeline-count').textContent=\`(\${items.length})\`;
  renderPipelineRows(items);
}
function renderPipelineRows(items){
  const tbody=document.getElementById('pipeline-body');
  const badge=document.getElementById('pipeline-count-badge');
  badge.textContent=\`\${items.length} job\${items.length!==1?'s':''}\`;
  if(!items.length){tbody.innerHTML=\`<tr><td colspan="5"><div class="empty"><span class="empty-icon">📭</span><p>no pending jobs. add urls to data/pipeline.md or use the search tab</p></div></td></tr>\`;return}
  tbody.innerHTML=items.map((j,i)=>{
    const ats=j.ats?\`<span class="ats-tag">\${esc(j.ats)}</span>\`:'—';
    return \`<tr>
      <td style="color:var(--subtle);font-family:var(--mono);font-size:12px">\${i+1}</td>
      <td style="font-weight:600">\${esc(j.company)||'—'}</td>
      <td style="color:var(--muted)">\${esc(j.role)||'—'}</td>
      <td>\${ats}</td>
      <td><a href="\${esc(j.url)}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:11px">open ↗</a></td>
    </tr>\`;
  }).join('');
}
function filterPipeline(){const q=document.getElementById('pipeline-search').value.toLowerCase();renderPipelineRows(q?pipelineRows.filter(r=>(r.company+r.role).toLowerCase().includes(q)):pipelineRows)}

// ─── Applications tab ─────────────────────────────────────────────────────────
// (No full report data in server mode — show basic info from applications.md)
function renderApplications(){
  const apps=DATA.apps;
  document.getElementById('tab-apps-count').textContent=\`(\${apps.length})\`;
  const tbody=document.getElementById('apps-body');
  document.getElementById('apps-count-badge').textContent=\`\${apps.length} application\${apps.length!==1?'s':''}\`;
  if(!apps.length){tbody.innerHTML=\`<tr><td colspan="8"><div class="empty"><span class="empty-icon">📋</span><p>no applications yet.<br>evaluate jobs with /career-ops</p></div></td></tr>\`;return}
  tbody.innerHTML=apps.map((a,i)=>\`<tr>
    <td style="color:var(--subtle);font-family:var(--mono);font-size:12px">\${i+1}</td>
    <td colspan="2" style="font-weight:600">\${esc(a.company)}</td>
    <td colspan="2" style="color:var(--muted)">\${esc(a.role)}</td>
    <td colspan="3">\${statusBadge(a.status)}</td>
  </tr>\`).join('');
}

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
  const table=document.getElementById(id);const tbody=table.querySelector('tbody');
  const rows=[...tbody.querySelectorAll('tr:not(.detail-row)')];
  const asc=th.dataset.dir!=='asc';th.dataset.dir=asc?'asc':'desc';
  table.querySelectorAll('th').forEach(h=>{h.classList.remove('sorted');h.querySelector('.si').textContent='↕'});
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

  // ── GET / → dashboard HTML ──
  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    const page = buildPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }

  // ── POST /api/pipeline/add ──
  if (method === 'POST' && url === '/api/pipeline/add') {
    const body = await readBody(req);
    if (!body.url) return json(res, { error: 'url required' }, 400);
    const status = addToPipeline(body.url, body.company || '', body.role || '');
    return json(res, { status });
  }

  // ── POST /api/keywords/extract ──
  if (method === 'POST' && url === '/api/keywords/extract') {
    const body = await readBody(req);

    // Text mode: user pasted raw JD text
    if (body.text && !body.url) {
      const keywords = extractKeywords(body.text);
      return json(res, { keywords, source: 'text' });
    }

    if (!body.url) return json(res, { error: 'url or text required' }, 400);
    const result = await extractFromUrl(body.url);
    return json(res, result);
  }

  // ── POST /api/scan/run ──
  if (method === 'POST' && url === '/api/scan/run') {
    if (!fs.existsSync(path.join(ROOT, 'portals.yml'))) {
      return json(res, { error: 'portals.yml not found — run /career-ops to set up first' }, 400);
    }
    if (scanProcess && scanProcess.exitCode === null) {
      return json(res, { status: 'already_running' });
    }
    scanProcess = spawn('node', ['scan.mjs'], { cwd: ROOT, detached: false });
    scanProcess.on('error', (e) => console.error('[scan]', e.message));
    scanProcess.stdout?.on('data', d => process.stdout.write(`[scan] ${d}`));
    scanProcess.stderr?.on('data', d => process.stderr.write(`[scan] ${d}`));
    return json(res, { status: 'started' });
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n  career-ops dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Search tab:  browse scanned jobs, extract keywords, add to pipeline`);
  console.log(`  Keyword extraction works on Greenhouse, Lever, Ashby, and most ATS pages`);
  console.log(`  Press Ctrl+C to stop\n`);
});
