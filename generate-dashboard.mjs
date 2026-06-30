#!/usr/bin/env node
// generate-dashboard.mjs — builds dashboard.html from career-ops data files
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'dashboard.html');

// ─── ATS Detection ───────────────────────────────────────────────────────────

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
  if (u.includes('breezy')) return 'Breezy';
  if (u.includes('successfactors')) return 'SAP SF';
  if (u.includes('oraclecloud')) return 'Oracle';
  if (u.includes('remoteok')) return 'RemoteOK';
  if (u.includes('remotive')) return 'Remotive';
  return '';
}

// ─── Pipeline Parser ─────────────────────────────────────────────────────────

function parsePipeline(rootDir) {
  const fp = path.join(rootDir, 'data', 'pipeline.md');
  if (!fs.existsSync(fp)) return { pending: [], processed: [] };
  const text = fs.readFileSync(fp, 'utf8');

  const pending = [];
  const processed = [];
  let section = '';

  for (const line of text.split('\n')) {
    if (line.startsWith('## Pending')) { section = 'pending'; continue; }
    if (line.startsWith('## Processed')) { section = 'processed'; continue; }
    if (line.startsWith('## ')) { section = ''; continue; }

    const m = line.match(/^- \[([ x])\] (.+)/);
    if (!m) continue;

    const checked = m[1] === 'x';
    const rest = m[2].trim();
    const clean = rest.replace(/~~([^~]+)~~/g, '$1');
    const parts = clean.split(' | ');
    const url = parts[0].trim();
    const company = parts[1]?.trim() || '';
    const role = parts[2]?.trim() || '';
    const ats = detectATS(url);

    const entry = { url, company, role, ats };
    if (section === 'pending' && !checked) pending.push(entry);
    else processed.push(entry);
  }

  return { pending, processed };
}

// ─── Applications Parser ─────────────────────────────────────────────────────

function parseApplications(rootDir) {
  const fp = path.join(rootDir, 'data', 'applications.md');
  if (!fs.existsSync(fp)) return [];
  const text = fs.readFileSync(fp, 'utf8');
  const apps = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---')) continue;

    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length < 8) continue;

    const sm = cells[4]?.match(/(\d+\.?\d*)\/5/);
    const rm = cells[7]?.match(/\[(\d+)\]\(([^)]+)\)/);

    apps.push({
      num: cells[0],
      date: cells[1],
      company: cells[2],
      role: cells[3],
      score: sm ? parseFloat(sm[1]) : 0,
      scoreRaw: cells[4] || '',
      status: cells[5],
      hasPDF: cells[6]?.includes('✅'),
      reportNum: rm?.[1] || '',
      reportPath: rm?.[2] || '',
      notes: cells[8] || '',
    });
  }
  return apps;
}

// ─── Report Parser ───────────────────────────────────────────────────────────

const TECH_RE = /\b(Python|JavaScript|TypeScript|SQL|R(?=[\s,]|$)|Go(?=[\s,]|$)|Java(?!Script)|Scala|Rust|C\+\+|React|Node\.?js|Docker|Kubernetes|K8s|AWS|GCP|Azure|Spark|Kafka|Airflow|dbt|Tableau|Power\s*BI|TensorFlow|PyTorch|scikit.learn|NLP|LLM|RAG|API|ETL|CI\/CD|Git|PostgreSQL|Postgres|MongoDB|Redis|Snowflake|BigQuery|Databricks|MLflow|Grafana|FastAPI|Django|Flask|vector\s+(?:search|DB|database|store)|embeddings|LangChain|OpenAI|transformer|BERT|GPT|fine.tun\w*|prompt\s+engineer\w*|agentic|multi.agent|orchestration|feature\s+store|data\s+warehouse|data\s+lake|microservices|REST|GraphQL|Terraform|Helm|A\/B\s+testing|experimentation|machine\s+learning|deep\s+learning|computer\s+vision|recommendation|time\s+series|reinforcement\s+learning|statistics|hypothesis\s+test\w*|causal\s+\w+|observability|monitoring|inference|evaluation|Looker|Mixpanel|DuckDB|Polars|Pandas|NumPy|Matplotlib|Seaborn|Plotly|Streamlit|HuggingFace|Hugging\s+Face|RLHF|HITL)\b/gi;

function extractTechKeywords(text) {
  const seen = new Set();
  const result = [];
  TECH_RE.lastIndex = 0;
  let m;
  while ((m = TECH_RE.exec(text)) !== null) {
    const kw = m[0].trim();
    const key = kw.toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) { seen.add(key); result.push(kw); }
  }
  return result;
}

function parseReport(rootDir, relPath) {
  const full = relPath.startsWith('../')
    ? path.resolve(rootDir, 'data', relPath)
    : path.resolve(rootDir, relPath);

  if (!fs.existsSync(full)) return null;
  const text = fs.readFileSync(full, 'utf8');

  const r = {
    archetype: '', domain: '', remote: '', tldr: '',
    url: '', date: '', requirements: [], gaps: [],
    cvChanges: [], keywords: [],
  };

  r.url = text.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/i)?.[1]?.trim() || '';
  r.date = text.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || '';
  r.archetype = text.match(/\*\*Archetype:\*\*\s*([^\n]+)/i)?.[1]?.trim() || '';

  const aBlock = text.match(/## A\)[^\n]*\n([\s\S]*?)(?=\n## B\)|\n---)/i)?.[1] || '';
  const pickCell = (block, label) => {
    const m = block.match(new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*([^|\\n]+)`, 'i'));
    return m?.[1]?.trim() || '';
  };
  r.archetype = pickCell(aBlock, 'Archetype') || r.archetype;
  r.domain = pickCell(aBlock, 'Domain');
  r.remote = pickCell(aBlock, 'Remote');
  r.tldr = pickCell(aBlock, 'TL;DR');

  const bBlock = text.match(/## B\)[^\n]*\n([\s\S]*?)(?=\n## C\)|\n---)/i)?.[1] || '';
  const gapsIdx = bBlock.toLowerCase().indexOf('### gaps');
  const preGaps = gapsIdx >= 0 ? bBlock.slice(0, gapsIdx) : bBlock;
  const gapsText = gapsIdx >= 0 ? bBlock.slice(gapsIdx) : '';

  for (const line of preGaps.split('\n')) {
    const m = line.match(/^\|\s*"?([^"|{][^"|]{3,}?)"?\s*\|/);
    if (!m) continue;
    const val = m[1].replace(/\*\*/g, '').trim();
    if (val && !/^(JD Req|CV Match|Source|---)/i.test(val)) r.requirements.push(val);
  }

  for (const line of gapsText.split('\n')) {
    const m = line.match(/^\|\s*"?([^"|]+)"?\s*\|\s*([^|]+)\|/);
    if (!m) continue;
    const gap = m[1].replace(/\*\*/g, '').trim();
    const sev = m[2].trim();
    if (gap && !/^(Gap|---)/i.test(gap)) r.gaps.push({ gap, severity: sev });
  }

  const eBlock = text.match(/## E\)[^\n]*\n([\s\S]*?)(?=\n## F\)|\n---)/i)?.[1] || '';
  for (const line of eBlock.split('\n')) {
    const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|([^|]*)\|/);
    if (m) {
      r.cvChanges.push({
        section: m[1].trim(),
        current: m[2].trim(),
        change: m[3].trim(),
        why: m[4].trim(),
      });
    }
  }

  const kwLine = text.match(/## Keywords Extracted\s*\n+([^\n#]+)/i)?.[1];
  if (kwLine) {
    r.keywords = kwLine.split(',').map(k => k.trim()).filter(Boolean);
  }

  if (r.keywords.length === 0) {
    r.keywords = extractTechKeywords(r.requirements.join(' ') + ' ' + eBlock);
  }

  return r;
}

// ─── Data Assembly ────────────────────────────────────────────────────────────

function buildData() {
  const pipeline = parsePipeline(ROOT);
  const apps = parseApplications(ROOT);

  const enriched = apps.map(app => {
    const report = app.reportPath ? parseReport(ROOT, app.reportPath) : null;
    return { ...app, report };
  });

  const freq = {};
  for (const app of enriched) {
    if (!app.report) continue;
    for (const kw of app.report.keywords) {
      const key = kw.toLowerCase();
      freq[key] = { count: (freq[key]?.count || 0) + 1, display: kw };
    }
  }
  const keywordFreq = Object.values(freq)
    .sort((a, b) => b.count - a.count)
    .slice(0, 40)
    .map(e => [e.display, e.count]);

  return {
    generated: new Date().toISOString(),
    pipeline,
    applications: enriched,
    keywordFreq,
  };
}

// ─── HTML Template ────────────────────────────────────────────────────────────

function html(data) {
  const json = JSON.stringify(data);
  const ts = new Date(data.generated).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>career-ops</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0B0B0F;
  --surface:#111116;
  --surface2:#18181F;
  --border:#22222D;
  --border-hi:#333345;
  --text:#E2E0EF;
  --muted:#7B7994;
  --subtle:#4B4964;
  --gold:#C49450;
  --gold-bg:#1A1206;
  --green:#5CC98A;
  --green-bg:#061509;
  --blue:#5BA0F0;
  --blue-bg:#060F1E;
  --red:#E85555;
  --red-bg:#1A0606;
  --amber:#E8943A;
  --amber-bg:#1A0D04;
  --purple:#9D6FE8;
  --purple-bg:#120A1E;
  --cyan:#5BC4CE;
  --cyan-bg:#051418;
  --mono:'Menlo','Monaco','Consolas','Courier New',monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}

body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.5;min-height:100vh}
a{color:var(--gold);text-decoration:none}
a:hover{color:var(--text);text-decoration:underline}

/* ── Header ── */
.header{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--border)}
.wordmark{font-family:var(--mono);font-size:14px;display:flex;align-items:center;gap:8px}
.wordmark-app{color:var(--gold);font-weight:700}
.wordmark-sep{color:var(--border-hi)}
.wordmark-sub{color:var(--subtle)}
.header-right{display:flex;align-items:center;gap:16px}
.header-ts{font-family:var(--mono);font-size:11px;color:var(--subtle)}
.header-refresh{font-family:var(--mono);font-size:11px;color:var(--subtle);border:1px solid var(--border);padding:3px 8px;border-radius:2px;cursor:pointer;background:none;transition:all .15s}
.header-refresh:hover{border-color:var(--gold);color:var(--gold)}
.main{padding:28px;max-width:1440px;margin:0 auto}

/* ── Stat cards ── */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:32px}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:560px){.stats{grid-template-columns:1fr 1fr}}
.stat{background:var(--bg);padding:22px 24px;position:relative;overflow:hidden}
.stat::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat:nth-child(1)::after{background:var(--gold)}
.stat:nth-child(2)::after{background:var(--blue)}
.stat:nth-child(3)::after{background:var(--cyan)}
.stat:nth-child(4)::after{background:var(--green)}
.stat:nth-child(5)::after{background:var(--purple)}
.stat-value{font-family:var(--mono);font-size:34px;font-weight:700;line-height:1;letter-spacing:-1.5px;tab-size:4}
.stat-label{font-size:10px;color:var(--subtle);margin-top:10px;text-transform:uppercase;letter-spacing:1.4px;font-weight:500;font-family:var(--mono)}

/* ── Tabs ── */
.tabs{display:flex;border-bottom:1px solid var(--border);margin-bottom:24px;gap:0}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--subtle);cursor:pointer;padding:10px 22px;font-family:var(--mono);font-size:12px;font-weight:400;transition:color .12s;margin-bottom:-1px;white-space:nowrap;outline:none}
.tab:hover{color:var(--muted)}
.tab.active{color:var(--gold);border-bottom-color:var(--gold)}
.tab.active::before{content:'› '}
.tab-content{display:none}
.tab-content.active{display:block}

/* ── Toolbar ── */
.toolbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.search{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:2px;padding:7px 12px;font-family:var(--mono);font-size:12px;width:220px;outline:none;transition:border-color .12s}
.search:focus{border-color:var(--gold)}
.search::placeholder{color:var(--subtle)}
.filter-btn{background:transparent;border:1px solid var(--border);color:var(--subtle);border-radius:2px;padding:5px 10px;font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .12s;line-height:1}
.filter-btn:hover{color:var(--muted);border-color:var(--border-hi)}
.filter-btn.active{border-color:var(--gold);color:var(--gold)}
.count-badge{font-family:var(--mono);font-size:11px;color:var(--subtle);margin-left:auto}

/* ── Table ── */
.table-wrap{overflow-x:auto;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;white-space:nowrap}
th{background:var(--surface);color:var(--subtle);font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.9px;padding:9px 14px;text-align:left;border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
th:hover{color:var(--muted)}
th .sort-icon{opacity:.25;margin-left:4px}
th.sorted .sort-icon{opacity:1;color:var(--gold)}
td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text)}
tr:last-child td{border-bottom:none}
tr.expandable{cursor:pointer}
tr.expandable:hover td{background:var(--surface)}
tr.detail-row td{background:var(--surface);padding:0;border-bottom:2px solid var(--border-hi)}
tr.detail-row.hidden{display:none}

/* ── Status badges — dot + monospace text, no filled backgrounds ── */
.badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:11px;font-weight:500;white-space:nowrap}
.badge::before{content:'●';font-size:7px;flex-shrink:0;position:relative;top:-0.5px}
.badge-blue{color:var(--blue)}
.badge-green{color:var(--green)}
.badge-amber{color:var(--amber)}
.badge-red{color:var(--red)}
.badge-purple{color:var(--purple)}
.badge-cyan{color:var(--cyan)}
.badge-gray{color:var(--muted)}

/* ── Score — monospace text, no pill ── */
.score{font-family:var(--mono);font-size:13px;font-weight:700}
.score-hi{color:var(--green)}
.score-ok{color:var(--blue)}
.score-mid{color:var(--amber)}
.score-lo{color:var(--red)}

/* ── ATS tag ── */
.ats-tag{font-family:var(--mono);font-size:10px;padding:2px 6px;background:var(--surface2);color:var(--subtle);border:1px solid var(--border);border-radius:2px}

/* ── Detail panel ── */
.detail-panel{padding:20px 24px;display:grid;gap:18px;border-top:2px solid var(--border-hi)}
.detail-section h4{font-family:var(--mono);font-size:9px;color:var(--subtle);text-transform:uppercase;letter-spacing:1.3px;margin-bottom:10px;font-weight:600}
.kw-list{display:flex;flex-wrap:wrap;gap:5px}
.kw{font-family:var(--mono);background:var(--surface2);border:1px solid var(--border-hi);color:var(--muted);border-radius:2px;padding:2px 7px;font-size:11px;cursor:default;transition:border-color .1s,color .1s}
.kw:hover{border-color:var(--gold);color:var(--text)}
.kw.gap-high{border-color:var(--red);color:var(--red);background:var(--red-bg)}
.kw.gap-med{border-color:var(--amber);color:var(--amber);background:var(--amber-bg)}
.tldr{color:var(--muted);font-size:13px;line-height:1.65;border-left:2px solid var(--border-hi);padding-left:14px;margin:0}
.cv-changes{display:grid;gap:6px}
.cv-change{background:transparent;border-left:2px solid var(--gold);padding:8px 14px}
.section-label{font-family:var(--mono);font-size:9px;color:var(--gold);font-weight:700;letter-spacing:.9px;text-transform:uppercase;margin-bottom:4px}
.change-text{font-size:13px;color:var(--text);line-height:1.45}
.why-text{font-size:11px;color:var(--subtle);margin-top:4px;line-height:1.45}
.gap-item{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)}
.gap-item:last-child{border-bottom:none}
.sev{font-family:var(--mono);font-size:9px;padding:2px 6px;border-radius:2px;flex-shrink:0;font-weight:700;margin-top:2px;letter-spacing:.6px;text-transform:uppercase}
.sev-high{background:var(--red-bg);color:var(--red);border:1px solid var(--red)}
.sev-med{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber)}
.sev-low{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue)}

/* ── Keywords tab ── */
.kw-section{background:var(--surface);border:1px solid var(--border);padding:22px 24px;margin-bottom:16px}
.kw-section h3{font-family:var(--mono);font-size:10px;color:var(--subtle);text-transform:uppercase;letter-spacing:1.1px;font-weight:600;margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.kw-freq-list{display:grid;gap:6px}
.kw-freq-item{display:flex;align-items:center;gap:12px}
.kw-freq-name{width:180px;font-family:var(--mono);font-size:11px;color:var(--muted);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kw-freq-bar-wrap{flex:1;background:var(--surface2);height:3px;overflow:hidden}
.kw-freq-bar{height:100%;background:var(--gold);opacity:.6;transition:width .4s}
.kw-freq-count{font-family:var(--mono);font-size:11px;color:var(--subtle);width:24px;text-align:right;flex-shrink:0}

/* ── Charts ── */
.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.chart-card{background:var(--surface);border:1px solid var(--border);padding:22px 24px}
.chart-card h3{font-family:var(--mono);font-size:10px;color:var(--subtle);text-transform:uppercase;letter-spacing:1.1px;font-weight:600;margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.funnel{display:flex;flex-direction:column;gap:7px}
.funnel-row{display:flex;align-items:center;gap:10px}
.funnel-label{width:76px;font-family:var(--mono);font-size:10px;color:var(--subtle);flex-shrink:0}
.funnel-bar-wrap{flex:1;background:var(--surface2);height:18px;overflow:hidden}
.funnel-bar{height:100%;display:flex;align-items:center;padding-left:8px;font-family:var(--mono);font-size:10px;font-weight:700;min-width:28px}
.funnel-pct{width:30px;font-family:var(--mono);font-size:10px;color:var(--subtle);text-align:right;flex-shrink:0}
.score-dist{display:flex;flex-direction:column;gap:7px}
.score-row{display:flex;align-items:center;gap:10px}
.score-label{width:52px;font-family:var(--mono);font-size:10px;color:var(--subtle);flex-shrink:0}
.score-bar-wrap{flex:1;background:var(--surface2);height:18px;overflow:hidden}
.score-bar{height:100%;display:flex;align-items:center;padding-left:6px;font-family:var(--mono);font-size:10px;font-weight:700;min-width:22px}
.score-count{width:22px;font-family:var(--mono);font-size:10px;color:var(--subtle);text-align:right;flex-shrink:0}
.weekly{display:flex;align-items:flex-end;gap:6px;height:88px}
.week-col{display:flex;flex-direction:column;align-items:center;flex:1;gap:4px}
.week-bar{width:100%;background:var(--gold);opacity:.55;min-height:2px;border-radius:1px 1px 0 0}
.week-label{font-family:var(--mono);font-size:9px;color:var(--subtle);writing-mode:vertical-rl;transform:rotate(180deg);height:34px;display:flex;align-items:center}
.status-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
.status-row:last-child{border-bottom:none}
.status-count{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text)}

/* ── Empty states ── */
.empty{text-align:center;padding:64px 24px;color:var(--subtle)}
.empty-icon{font-size:26px;margin-bottom:16px;display:block;opacity:.4}
.empty p{font-size:12px;line-height:1.75;max-width:260px;margin:0 auto;font-family:var(--mono)}

/* ── Focus & a11y ── */
:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
@media(prefers-reduced-motion:reduce){
  .stat-value,.kw-freq-bar,.funnel-bar,.score-bar{transition:none}
}
@media(max-width:640px){
  .main{padding:16px}
  .kw-freq-name{width:120px}
  .tab{padding:9px 12px;font-size:11px}
  .header{padding:14px 16px}
}
</style>
</head>
<body>

<header class="header">
  <div class="wordmark">
    <span class="wordmark-app">career-ops</span>
    <span class="wordmark-sep">/</span>
    <span class="wordmark-sub">dashboard</span>
  </div>
  <div class="header-right">
    <span class="header-ts">${ts}</span>
    <button class="header-refresh" onclick="location.reload()">↺ refresh</button>
  </div>
</header>

<div class="main">

  <div class="stats" id="stats-row"></div>

  <nav class="tabs">
    <button class="tab active" data-tab="pipeline">pipeline <span id="tab-pipeline-count"></span></button>
    <button class="tab" data-tab="applications">applications <span id="tab-apps-count"></span></button>
    <button class="tab" data-tab="keywords">keywords</button>
    <button class="tab" data-tab="charts">charts</button>
  </nav>

  <div id="pipeline" class="tab-content active">
    <div class="toolbar">
      <input class="search" id="pipeline-search" placeholder="filter by company or role" oninput="filterPipeline()">
      <span class="count-badge" id="pipeline-count-badge"></span>
    </div>
    <div class="table-wrap">
      <table id="pipeline-table">
        <thead><tr>
          <th onclick="sortTable('pipeline-table',0,this)">#<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('pipeline-table',1,this)">company<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('pipeline-table',2,this)">role<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('pipeline-table',3,this)">ats<span class="sort-icon">↕</span></th>
          <th>link</th>
        </tr></thead>
        <tbody id="pipeline-body"></tbody>
      </table>
    </div>
  </div>

  <div id="applications" class="tab-content">
    <div class="toolbar">
      <input class="search" id="apps-search" placeholder="filter by company or role" oninput="filterApps()">
      <div id="status-filters" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      <span class="count-badge" id="apps-count-badge"></span>
    </div>
    <div class="table-wrap">
      <table id="apps-table">
        <thead><tr>
          <th onclick="sortTable('apps-table',0,this)">#<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('apps-table',1,this)">date<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('apps-table',2,this)">company<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('apps-table',3,this)">role<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('apps-table',4,this)">score<span class="sort-icon">↕</span></th>
          <th onclick="sortTable('apps-table',5,this)">status<span class="sort-icon">↕</span></th>
          <th>pdf</th>
          <th>report</th>
        </tr></thead>
        <tbody id="apps-body"></tbody>
      </table>
    </div>
  </div>

  <div id="keywords" class="tab-content">
    <div id="kw-content"></div>
  </div>

  <div id="charts" class="tab-content">
    <div class="charts-grid" id="charts-content"></div>
  </div>

</div>

<script>
const DATA = ${json};

// ─── Utilities ──────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statusBadge(status) {
  const s = (status || '').toLowerCase();
  let cls = 'badge-gray', label = status || '—';
  if (s.includes('interview'))  cls = 'badge-green';
  else if (s.includes('offer')) cls = 'badge-purple';
  else if (s.includes('applied')) cls = 'badge-blue';
  else if (s.includes('evaluated')) cls = 'badge-amber';
  else if (s.includes('responded')) cls = 'badge-cyan';
  else if (s.includes('rejected') || s.includes('discarded') || s === 'skip') cls = 'badge-gray';
  return \`<span class="badge \${cls}">\${esc(label)}</span>\`;
}

function scorePill(score) {
  if (!score) return \`<span style="color:var(--subtle);font-family:var(--mono)">—</span>\`;
  const cls = score >= 4.5 ? 'score-hi' : score >= 4.0 ? 'score-ok' : score >= 3.5 ? 'score-mid' : 'score-lo';
  return \`<span class="score \${cls}">\${score.toFixed(1)}</span>\`;
}

function sevClass(sev) {
  const s = (sev || '').toLowerCase();
  if (s.includes('high') || s.includes('hard')) return 'sev-high';
  if (s.includes('med')) return 'sev-med';
  return 'sev-low';
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function renderStats() {
  const apps = DATA.applications;
  const scored = apps.filter(a => a.score > 0);
  const avg = scored.length ? scored.reduce((s, a) => s + a.score, 0) / scored.length : null;
  const interviews = apps.filter(a => /interview/i.test(a.status)).length;
  const applied = apps.filter(a => /applied|responded|interview|offer/i.test(a.status)).length;

  const cards = [
    { value: DATA.pipeline.pending.length, label: 'pending',    color: 'var(--gold)',   isInt: true  },
    { value: apps.length,                  label: 'evaluated',  color: 'var(--blue)',   isInt: true  },
    { value: applied,                      label: 'applied',    color: 'var(--cyan)',   isInt: true  },
    { value: avg,                          label: 'avg score',  color: avg >= 4 ? 'var(--green)' : avg ? 'var(--amber)' : 'var(--subtle)', isInt: false },
    { value: interviews,                   label: 'interviews', color: 'var(--purple)', isInt: true  },
  ];

  document.getElementById('stats-row').innerHTML = cards.map((c, i) => {
    const display = c.value === null ? '—' : c.isInt ? String(c.value) : c.value.toFixed(1);
    return \`<div class="stat"><div class="stat-value" id="sv-\${i}" style="color:\${c.color}">\${display}</div><div class="stat-label">\${c.label}</div></div>\`;
  }).join('');

  // Count-up animation on load
  cards.forEach((c, i) => {
    if (!c.value || c.value === 0) return;
    const el = document.getElementById(\`sv-\${i}\`);
    const target = c.value;
    const duration = 480 + i * 70;
    const start = performance.now();
    const tick = (ts) => {
      const p = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = c.isInt ? String(Math.round(target * ease)) : (target * ease).toFixed(1);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = c.isInt ? String(target) : target.toFixed(1);
    };
    requestAnimationFrame(tick);
  });
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

let pipelineRows = [];

function renderPipeline() {
  const items = DATA.pipeline.pending;
  pipelineRows = items;
  document.getElementById('tab-pipeline-count').textContent = \`(\${items.length})\`;
  renderPipelineRows(items);
}

function renderPipelineRows(items) {
  const tbody = document.getElementById('pipeline-body');
  const badge = document.getElementById('pipeline-count-badge');

  if (!items.length) {
    tbody.innerHTML = \`<tr><td colspan="5"><div class="empty"><span class="empty-icon">📭</span><p>no pending jobs. add urls to data/pipeline.md</p></div></td></tr>\`;
    badge.textContent = '';
    return;
  }
  badge.textContent = \`\${items.length} job\${items.length !== 1 ? 's' : ''}\`;
  tbody.innerHTML = items.map((item, i) => {
    const ats = item.ats ? \`<span class="ats-tag">\${esc(item.ats)}</span>\` : \`<span style="color:var(--subtle)">—</span>\`;
    const link = item.url
      ? \`<a href="\${esc(item.url)}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:11px">open ↗</a>\`
      : '—';
    return \`<tr>
      <td style="color:var(--subtle);font-family:var(--mono);font-size:12px">\${i + 1}</td>
      <td style="font-weight:600">\${esc(item.company) || '—'}</td>
      <td style="color:var(--muted)">\${esc(item.role) || '—'}</td>
      <td>\${ats}</td>
      <td>\${link}</td>
    </tr>\`;
  }).join('');
}

function filterPipeline() {
  const q = document.getElementById('pipeline-search').value.toLowerCase();
  renderPipelineRows(q ? pipelineRows.filter(r => (r.company + r.role).toLowerCase().includes(q)) : pipelineRows);
}

// ─── Applications ────────────────────────────────────────────────────────────

let appRows = [];
let activeStatus = '';

function renderApplications() {
  const apps = DATA.applications;
  appRows = apps;
  document.getElementById('tab-apps-count').textContent = \`(\${apps.length})\`;

  const statuses = [...new Set(apps.map(a => a.status).filter(Boolean))].sort();
  document.getElementById('status-filters').innerHTML =
    \`<button class="filter-btn active" onclick="setStatusFilter('',this)">all</button>\` +
    statuses.map(s => \`<button class="filter-btn" onclick="setStatusFilter('\${esc(s)}',this)">\${esc(s)}</button>\`).join('');

  renderAppRows(apps);
}

function setStatusFilter(status, btn) {
  activeStatus = status;
  document.querySelectorAll('#status-filters .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyAppFilters();
}

function filterApps() { applyAppFilters(); }

function applyAppFilters() {
  const q = document.getElementById('apps-search').value.toLowerCase();
  let rows = appRows;
  if (activeStatus) rows = rows.filter(a => a.status === activeStatus);
  if (q) rows = rows.filter(a => (a.company + a.role + a.notes).toLowerCase().includes(q));
  renderAppRows(rows);
}

function renderAppRows(apps) {
  const tbody = document.getElementById('apps-body');
  document.getElementById('apps-count-badge').textContent =
    \`\${apps.length} application\${apps.length !== 1 ? 's' : ''}\`;

  if (!apps.length) {
    tbody.innerHTML = \`<tr><td colspan="8"><div class="empty"><span class="empty-icon">📋</span><p>no applications yet. evaluate a job with /career-ops</p></div></td></tr>\`;
    return;
  }

  tbody.innerHTML = apps.map((app, i) => {
    const detailId = \`detail-\${i}\`;
    const report = app.report;
    const pdf = app.hasPDF ? '✓' : \`<span style="color:var(--subtle)">—</span>\`;
    const reportLink = app.reportPath
      ? \`<a href="\${esc(app.reportPath)}" target="_blank" style="font-family:var(--mono);font-size:11px">#\${esc(app.reportNum)}</a>\`
      : \`<span style="color:var(--subtle)">—</span>\`;

    let detail = '';
    if (report) {
      const metaParts = [
        report.archetype && \`<span class="badge badge-blue">\${esc(report.archetype)}</span>\`,
        report.remote    && \`<span class="badge badge-gray">\${esc(report.remote)}</span>\`,
        report.domain    && \`<span class="badge badge-gray">\${esc(report.domain)}</span>\`,
        report.url       && \`<a href="\${esc(report.url)}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:11px;margin-left:4px">view jd ↗</a>\`,
      ].filter(Boolean).join(' ');

      const tldr = report.tldr
        ? \`<p class="tldr">\${esc(report.tldr)}</p>\` : '';

      const kws = report.keywords.length
        ? \`<div class="detail-section"><h4>resume keywords</h4><div class="kw-list">\${report.keywords.map(k => \`<span class="kw">\${esc(k)}</span>\`).join('')}</div></div>\`
        : '';

      const cvChanges = report.cvChanges.length
        ? \`<div class="detail-section"><h4>cv tailoring</h4><div class="cv-changes">\${report.cvChanges.map(c => \`
            <div class="cv-change">
              <div class="section-label">\${esc(c.section)}</div>
              <div class="change-text">\${esc(c.change)}</div>
              \${c.why ? \`<div class="why-text">\${esc(c.why)}</div>\` : ''}
            </div>\`).join('')}</div></div>\`
        : '';

      const gaps = report.gaps.length
        ? \`<div class="detail-section"><h4>gaps</h4>\${report.gaps.map(g => \`
            <div class="gap-item">
              <span class="sev \${sevClass(g.severity)}">\${esc(g.severity)}</span>
              <span style="font-size:13px;color:var(--muted)">\${esc(g.gap)}</span>
            </div>\`).join('')}</div>\`
        : '';

      const reqs = report.requirements.length
        ? \`<div class="detail-section"><h4>jd requirements</h4><div class="kw-list">\${report.requirements.map(r => \`<span class="kw">\${esc(r)}</span>\`).join('')}</div></div>\`
        : '';

      detail = \`<div class="detail-panel">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">\${metaParts}</div>
        \${tldr}\${kws}\${cvChanges}\${gaps}\${reqs}
      </div>\`;
    } else if (app.reportPath) {
      detail = \`<div class="detail-panel"><p style="color:var(--subtle);font-family:var(--mono);font-size:12px">report not found at \${esc(app.reportPath)}</p></div>\`;
    } else {
      detail = \`<div class="detail-panel"><p style="color:var(--subtle);font-family:var(--mono);font-size:12px">no report — run /career-ops to evaluate this job</p></div>\`;
    }

    return \`<tr class="expandable" onclick="toggleDetail('\${detailId}')">
      <td style="color:var(--subtle);font-family:var(--mono);font-size:12px">\${esc(app.num)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--muted)">\${esc(app.date)}</td>
      <td style="font-weight:600">\${esc(app.company)}</td>
      <td style="color:var(--muted)">\${esc(app.role)}</td>
      <td>\${scorePill(app.score)}</td>
      <td>\${statusBadge(app.status)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--green)">\${pdf}</td>
      <td>\${reportLink}</td>
    </tr>
    <tr id="\${detailId}" class="detail-row hidden"><td colspan="8">\${detail}</td></tr>\`;
  }).join('');
}

function toggleDetail(id) {
  document.getElementById(id).classList.toggle('hidden');
}

// ─── Keywords ────────────────────────────────────────────────────────────────

function renderKeywords() {
  const el = document.getElementById('kw-content');
  const freq = DATA.keywordFreq;

  if (!freq.length) {
    el.innerHTML = \`<div class="empty"><span class="empty-icon">◈</span><p>no keyword data yet. evaluate jobs with /career-ops first.</p></div>\`;
    return;
  }

  const maxCount = freq[0]?.[1] || 1;
  const bars = freq.map(([kw, count]) =>
    \`<div class="kw-freq-item">
      <div class="kw-freq-name" title="\${esc(kw)}">\${esc(kw)}</div>
      <div class="kw-freq-bar-wrap"><div class="kw-freq-bar" style="width:\${Math.round(count / maxCount * 100)}%"></div></div>
      <div class="kw-freq-count">\${count}</div>
    </div>\`).join('');

  const perJob = DATA.applications
    .filter(a => a.report?.keywords?.length)
    .map(app => {
      const r = app.report;
      const kws = r.keywords.map(k => \`<span class="kw">\${esc(k)}</span>\`).join('');
      const suggestions = r.cvChanges.slice(0, 3).map(c =>
        \`<div class="cv-change" style="margin-top:6px">
          <div class="section-label">\${esc(c.section)}</div>
          <div class="change-text">\${esc(c.change)}</div>
        </div>\`).join('');
      return \`<div style="margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <strong>\${esc(app.company)}</strong>
          <span style="color:var(--muted);font-size:12px">\${esc(app.role)}</span>
          \${scorePill(app.score)}
          \${statusBadge(app.status)}
        </div>
        <div class="kw-list" style="margin-bottom:\${suggestions ? '10px' : '0'}">\${kws}</div>
        \${suggestions}
      </div>\`;
    }).join('');

  el.innerHTML = \`
    <div class="kw-section">
      <h3>keyword frequency — all evaluations</h3>
      <div class="kw-freq-list">\${bars}</div>
    </div>
    \${perJob ? \`<div class="kw-section"><h3>per-job breakdown</h3>\${perJob}</div>\` : ''}
  \`;
}

// ─── Charts ──────────────────────────────────────────────────────────────────

function renderCharts() {
  const apps = DATA.applications;
  const el = document.getElementById('charts-content');

  if (!apps.length) {
    el.innerHTML = \`<div class="empty"><span class="empty-icon">◈</span><p>no data yet. evaluate some jobs first.</p></div>\`;
    return;
  }

  // Funnel
  const total = apps.length;
  const applied    = apps.filter(a => /applied|responded|interview|offer/i.test(a.status)).length;
  const responded  = apps.filter(a => /responded|interview|offer/i.test(a.status)).length;
  const interview  = apps.filter(a => /interview|offer/i.test(a.status)).length;
  const offer      = apps.filter(a => /offer/i.test(a.status)).length;

  const stages = [
    { label: 'Evaluated', count: total,     pct: 100,                             color: 'var(--gold)'   },
    { label: 'Applied',   count: applied,   pct: total    ? applied/total*100    : 0, color: 'var(--blue)'  },
    { label: 'Responded', count: responded, pct: applied  ? responded/applied*100 : 0, color: 'var(--cyan)'  },
    { label: 'Interview', count: interview, pct: applied  ? interview/applied*100  : 0, color: 'var(--green)' },
    { label: 'Offer',     count: offer,     pct: applied  ? offer/applied*100      : 0, color: 'var(--purple)'},
  ];

  const funnel = stages.map(s =>
    \`<div class="funnel-row">
      <div class="funnel-label">\${s.label}</div>
      <div class="funnel-bar-wrap">
        <div class="funnel-bar" style="width:\${Math.max(s.pct, s.count ? 3 : 0)}%;background:\${s.color};opacity:.8">
          \${s.count}
        </div>
      </div>
      <div class="funnel-pct">\${s.pct.toFixed(0)}%</div>
    </div>\`).join('');

  // Score distribution
  const buckets = [
    { label: '4.5–5.0', min: 4.5, max: 6.0, color: 'var(--green)'  },
    { label: '4.0–4.4', min: 4.0, max: 4.5, color: 'var(--blue)'   },
    { label: '3.5–3.9', min: 3.5, max: 4.0, color: 'var(--amber)'  },
    { label: '3.0–3.4', min: 3.0, max: 3.5, color: 'var(--red)'    },
    { label: '  <3.0',  min: 0,   max: 3.0, color: 'var(--subtle)' },
  ].map(b => ({ ...b, count: apps.filter(a => a.score >= b.min && a.score < b.max).length }));
  const maxBucket = Math.max(...buckets.map(b => b.count), 1);
  const scoreDist = buckets.map(b =>
    \`<div class="score-row">
      <div class="score-label">\${b.label}</div>
      <div class="score-bar-wrap">
        <div class="score-bar" style="width:\${Math.max(b.count / maxBucket * 100, b.count ? 3 : 0)}%;background:\${b.color};opacity:.75">
          \${b.count || ''}
        </div>
      </div>
      <div class="score-count">\${b.count}</div>
    </div>\`).join('');

  // Status breakdown
  const statusMap = {};
  for (const a of apps) statusMap[a.status] = (statusMap[a.status] || 0) + 1;
  const statusRows = Object.entries(statusMap).sort((a, b) => b[1] - a[1]).map(([s, n]) =>
    \`<div class="status-row">
      <span>\${statusBadge(s)}</span>
      <span class="status-count">\${n}</span>
    </div>\`).join('');

  // Weekly activity
  const weekMap = {};
  for (const a of apps) {
    if (!a.date) continue;
    const d = new Date(a.date + 'T00:00:00');
    if (isNaN(d)) continue;
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const wk = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    const key = \`\${d.getFullYear()}-W\${String(wk).padStart(2, '0')}\`;
    weekMap[key] = (weekMap[key] || 0) + 1;
  }
  const weeks = Object.keys(weekMap).sort().slice(-8);
  const maxW = Math.max(...weeks.map(w => weekMap[w]), 1);
  const weekChart = weeks.length
    ? \`<div class="weekly">\${weeks.map(w =>
        \`<div class="week-col">
          <div class="week-bar" style="height:\${Math.round(weekMap[w] / maxW * 76)}px" title="\${w}: \${weekMap[w]}"></div>
          <div class="week-label">\${w.slice(-3)}</div>
        </div>\`).join('')}</div>\`
    : \`<p style="color:var(--subtle);font-family:var(--mono);font-size:12px">no dated entries</p>\`;

  el.innerHTML = \`
    <div class="chart-card"><h3>application funnel</h3><div class="funnel">\${funnel}</div></div>
    <div class="chart-card"><h3>score distribution</h3><div class="score-dist">\${scoreDist}</div></div>
    <div class="chart-card"><h3>status breakdown</h3>\${statusRows}</div>
    <div class="chart-card"><h3>weekly activity — last 8 weeks</h3>\${weekChart}</div>
  \`;
}

// ─── Table sorting ───────────────────────────────────────────────────────────

function sortTable(tableId, col, th) {
  const table = document.getElementById(tableId);
  const tbody = table.querySelector('tbody');
  const mainRows = [...tbody.querySelectorAll('tr:not(.detail-row)')];
  const detailRows = [...tbody.querySelectorAll('tr.detail-row')];

  const asc = th.dataset.dir !== 'asc';
  th.dataset.dir = asc ? 'asc' : 'desc';
  table.querySelectorAll('th').forEach(h => {
    h.classList.remove('sorted');
    h.querySelector('.sort-icon').textContent = '↕';
  });
  th.classList.add('sorted');
  th.querySelector('.sort-icon').textContent = asc ? '↑' : '↓';

  mainRows.sort((a, b) => {
    const av = a.cells[col]?.textContent.trim() || '';
    const bv = b.cells[col]?.textContent.trim() || '';
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
    return asc ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  mainRows.forEach((r, i) => {
    tbody.appendChild(r);
    if (detailRows[i]) tbody.appendChild(detailRows[i]);
  });
}

// ─── Tab switching ───────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// ─── Init ────────────────────────────────────────────────────────────────────

renderStats();
renderPipeline();
renderApplications();
renderKeywords();
renderCharts();
</script>
</body>
</html>`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const data = buildData();
fs.writeFileSync(OUT, html(data), 'utf8');

const pending = data.pipeline.pending.length;
const apps = data.applications.length;
console.log(`✓ dashboard.html generated`);
console.log(`  ${pending} pending pipeline job${pending !== 1 ? 's' : ''}`);
console.log(`  ${apps} evaluated application${apps !== 1 ? 's' : ''}`);
console.log(`  ${data.keywordFreq.length} unique keywords tracked`);
console.log(`\n  Open: open dashboard.html`);
