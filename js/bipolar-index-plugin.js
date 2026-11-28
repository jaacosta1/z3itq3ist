/**
 * Perpetual Web Diary — Drop-In Plugin:
 *   1) Simple Entry & Tag Index (.pdx-) — Strictly non-clinical
 *   2) Science-Based Bipolar Disorder Tracker (.bpt-)
 *
 * Self-contained ES module. Requires zero edits to app.js, github.js, or features.js.
 */

const BPT_LOCAL_KEY = 'pd_bipolar_tracker_v1';
const BPT_REPO_PATH = 'data/bipolar-tracker.json';

/* ==========================================================================
   1. UTILITIES & SAFE HTML
   ========================================================================== */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftISO(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatShortDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function countWords(text) {
  const clean = String(text || '').trim();
  return clean ? clean.split(/\s+/).length : 0;
}

function extractTags(text, existingTags = []) {
  const set = new Set();
  (Array.isArray(existingTags) ? existingTags : []).forEach((t) => {
    const clean = String(t || '').trim().replace(/^#/, '').toLowerCase();
    if (clean) set.add(clean);
  });
  const matches = String(text || '').match(/(^|[\s(])#([a-zA-Z0-9_-]{2,40})/g) || [];
  matches.forEach((m) => {
    const tag = m.replace(/^[\s(]*#/, '').toLowerCase();
    if (tag && !/^\d+$/.test(tag)) set.add(tag);
  });
  return Array.from(set);
}

function makeExcerpt(text, maxLen = 155) {
  const clean = String(text || '')
    .replace(/[#*_>`~[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trim()}…`;
}

function showPluginToast(msg) {
  let el = document.getElementById('plug-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'plug-toast';
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      zIndex: '10050',
      padding: '9px 16px',
      borderRadius: '999px',
      background: '#1e2433',
      color: '#eef2f7',
      border: '1px solid rgba(229,184,105,0.45)',
      fontSize: '0.84rem',
      fontWeight: '600',
      boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
      transition: 'opacity 0.2s ease',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
  }, 2800);
}

/* ==========================================================================
   2. AES-256-GCM ENCRYPTION (Browser RAM Only) & GITHUB VAULT BRIDGE
   ========================================================================== */

const bptCrypto = {
  toB64(bytes) {
    let bin = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  },
  fromB64(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  },
  async deriveKey(password, saltBytes) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 210000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },
  async encryptJSON(obj, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(password, salt);
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return {
      v: 1,
      encrypted: true,
      alg: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256-210000',
      salt: this.toB64(salt),
      iv: this.toB64(iv),
      ct: this.toB64(cipher),
      updatedAt: new Date().toISOString(),
    };
  },
  async decryptJSON(envelope, password) {
    const salt = this.fromB64(envelope.salt);
    const iv = this.fromB64(envelope.iv);
    const ct = this.fromB64(envelope.ct);
    const key = await this.deriveKey(password, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  },
};

function discoverGitHubSettings() {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k === BPT_LOCAL_KEY) continue;
    try {
      const val = JSON.parse(localStorage.getItem(k) || 'null');
      if (!val || typeof val !== 'object') continue;
      const owner = val.owner || val.username || val.githubUser || val.ghUser;
      const token = val.token || val.pat || val.githubToken || val.ghToken;
      const vaultRepo = val.vaultRepo || val.privateRepo || val.dataRepo || val.repo;
      const branch = val.vaultBranch || val.branch || 'main';
      if (owner && vaultRepo && token) {
        return { owner, repo: vaultRepo, branch, token };
      }
    } catch {
      // ignore non-JSON keys
    }
  }
  return null;
}

async function fetchTrackerFromGitHub() {
  const cfg = discoverGitHubSettings();
  if (!cfg) return null;
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${BPT_REPO_PATH}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return { missing: true, sha: null };
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const json = await res.json();
  const decoded = decodeURIComponent(escape(atob((json.content || '').replace(/\n/g, ''))));
  return { payload: JSON.parse(decoded), sha: json.sha };
}

async function saveTrackerToGitHub(payload, existingSha = null) {
  const cfg = discoverGitHubSettings();
  if (!cfg) return { synced: false, reason: 'local-only' };
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${BPT_REPO_PATH}`;
  let sha = existingSha;
  if (!sha) {
    try {
      const check = await fetchTrackerFromGitHub();
      if (check && check.sha) sha = check.sha;
    } catch {
      // proceed without sha
    }
  }
  const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  const body = {
    message: `Update clinical tracker (${todayISO()})`,
    content: contentB64,
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub sync failed (${res.status})`);
  const out = await res.json();
  return { synced: true, sha: out.content?.sha || sha };
}

/* ==========================================================================
   3. DEFAULT BIPOLAR TRACKER STATE & STORAGE CONTROLLER
   ========================================================================== */

function createEmptyTrackerData() {
  return {
    version: 1,
    logs: {}, // keyed by YYYY-MM-DD
    milestones: [], // { id, date, label, note }
    screeners: [], // { id, date, type: 'ASRM' | 'PHQ9', score, answers, note }
    prodromes: {
      elevation: ['Decreased need for sleep', 'Starting multiple projects at once', 'Pressured / rapid thoughts'],
      depression: ['Social withdrawal', 'Heavy morning fatigue', 'Skipping routines or meals'],
    },
    safetyPlan: {
      warningSigns: '',
      internalCoping: '',
      socialDistractions: '',
      supportContacts: '',
      professionalsAndHotlines: '',
      safeEnvironment: '',
    },
    updatedAt: new Date().toISOString(),
  };
}

const pluginState = {
  trackerData: createEmptyTrackerData(),
  passphrase: null,
  lockedEnvelope: null,
  remoteSha: null,
  syncStatus: 'Local',
  activeTrackerTab: 'daily',
  selectedDate: todayISO(),
  chartRangeDays: 30,
  indexTab: 'entries', // 'entries' | 'tags'
  indexSearch: '',
  indexYear: 'all',
  indexTag: '',
  indexSort: 'newest',
};

async function loadTrackerStore() {
  let raw = null;
  try {
    const localStr = localStorage.getItem(BPT_LOCAL_KEY);
    if (localStr) raw = JSON.parse(localStr);
  } catch {
    raw = null;
  }

  try {
    const remote = await fetchTrackerFromGitHub();
    if (remote && remote.payload) {
      pluginState.remoteSha = remote.sha;
      const remoteTs = Date.parse(remote.payload.updatedAt || 0) || 0;
      const localTs = Date.parse(raw?.updatedAt || 0) || 0;
      if (!raw || remoteTs >= localTs) {
        raw = remote.payload;
        localStorage.setItem(BPT_LOCAL_KEY, JSON.stringify(raw));
      }
      pluginState.syncStatus = 'Vault Synced';
    } else if (remote && remote.missing) {
      pluginState.syncStatus = 'Vault Ready';
    }
  } catch {
    pluginState.syncStatus = discoverGitHubSettings() ? 'Offline (Local)' : 'Local';
  }

  if (!raw) {
    pluginState.trackerData = createEmptyTrackerData();
    pluginState.lockedEnvelope = null;
    return;
  }

  if (raw.encrypted) {
    if (pluginState.passphrase) {
      try {
        pluginState.trackerData = Object.assign(
          createEmptyTrackerData(),
          await bptCrypto.decryptJSON(raw, pluginState.passphrase)
        );
        pluginState.lockedEnvelope = null;
        return;
      } catch {
        pluginState.passphrase = null;
      }
    }
    pluginState.lockedEnvelope = raw;
  } else {
    pluginState.trackerData = Object.assign(createEmptyTrackerData(), raw);
    pluginState.lockedEnvelope = null;
  }
}

async function persistTrackerStore() {
  pluginState.trackerData.updatedAt = new Date().toISOString();
  const payload = pluginState.passphrase
    ? await bptCrypto.encryptJSON(pluginState.trackerData, pluginState.passphrase)
    : pluginState.trackerData;

  localStorage.setItem(BPT_LOCAL_KEY, JSON.stringify(payload));
  try {
    const res = await saveTrackerToGitHub(payload, pluginState.remoteSha);
    if (res.synced) {
      pluginState.remoteSha = res.sha;
      pluginState.syncStatus = 'Vault Synced';
    } else {
      pluginState.syncStatus = 'Local';
    }
  } catch {
    pluginState.syncStatus = 'Saved Locally (Sync Retry Needed)';
  }
}

/* ==========================================================================
   4. UNIVERSAL DIARY ENTRY SCANNER (Stacked Multi-Entries + #Tags)
   ========================================================================== */

function normalizeYearEntryList(yearVal) {
  if (!yearVal) return [];
  if (Array.isArray(yearVal)) return yearVal;
  if (Array.isArray(yearVal.entries)) return yearVal.entries;
  if (typeof yearVal === 'object' && (yearVal.body || yearVal.text || yearVal.content || yearVal.html)) {
    return [yearVal];
  }
  if (typeof yearVal === 'string') return [{ body: yearVal }];
  return [];
}

function scanAllDiaryEntries() {
  const results = [];
  const seen = new Set();

  const pushEntry = (isoDate, year, mmdd, idx, totalInYear, rawEntry) => {
    const text = String(rawEntry.body || rawEntry.text || rawEntry.content || '').trim();
    if (!text) return;
    const dedupeKey = `${isoDate}|${idx}|${text.slice(0, 60)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const createdAt = rawEntry.createdAt || rawEntry.updatedAt || rawEntry.timestamp || '';
    let hour = null;
    if (createdAt) {
      const parsed = new Date(createdAt);
      if (!Number.isNaN(parsed.getTime())) hour = parsed.getHours();
    }

    results.push({
      isoDate,
      year: String(year),
      mmdd,
      entryIndex: idx + 1,
      totalInYear,
      title: String(rawEntry.title || '').trim(),
      text,
      excerpt: makeExcerpt(text, 165),
      words: countWords(text),
      tags: extractTags(text, rawEntry.tags || []),
      createdAt,
      hour,
    });
  };

  const ingestDayObject = (mmdd, dayObj) => {
    if (!dayObj || typeof dayObj !== 'object' || !/^\d{2}-\d{2}$/.test(mmdd)) return;
    const yearsMap = dayObj.years && typeof dayObj.years === 'object' ? dayObj.years : dayObj;
    Object.keys(yearsMap).forEach((yr) => {
      if (!/^\d{4}$/.test(yr)) return;
      const list = normalizeYearEntryList(yearsMap[yr]);
      list.forEach((item, idx) => {
        pushEntry(`${yr}-${mmdd}`, yr, mmdd, idx, list.length, item);
      });
    });
  };

  // 1) Scan localStorage caches (works with sandbox, offline cache, & plain cache structures)
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k === BPT_LOCAL_KEY) continue;
    const rawStr = localStorage.getItem(k);
    if (!rawStr || rawStr[0] !== '{') continue;
    try {
      const parsed = JSON.parse(rawStr);
      if (!parsed || typeof parsed !== 'object') continue;
      if (/^\d{2}-\d{2}$/.test(k)) {
        ingestDayObject(k, parsed);
      } else if (parsed.days && typeof parsed.days === 'object') {
        Object.keys(parsed.days).forEach((d) => ingestDayObject(d, parsed.days[d]));
      } else {
        Object.keys(parsed).forEach((subKey) => {
          if (/^\d{2}-\d{2}$/.test(subKey)) ingestDayObject(subKey, parsed[subKey]);
          if (/^\d{4}-\d{2}-\d{2}$/.test(subKey)) {
            const yr = subKey.slice(0, 4);
            const mmdd = subKey.slice(5);
            const list = normalizeYearEntryList(parsed[subKey]);
            list.forEach((item, idx) => pushEntry(subKey, yr, mmdd, idx, list.length, item));
          }
        });
      }
    } catch {
      // ignore non-JSON
    }
  }

  // 2) Scan currently rendered DOM year columns (captures unlocked/decrypted active day in RAM)
  const activeMmdd = detectCurrentDiaryMMDD();
  document.querySelectorAll('.year-col, [data-year]').forEach((col) => {
    const yr = col.getAttribute('data-year') || (col.textContent.match(/\b(19|20)\d{2}\b/) || [])[0];
    if (!yr || !activeMmdd) return;
    const cards = col.querySelectorAll('.stacked-entry-item, .entry-body, .year-entry-body');
    const items = cards.length ? Array.from(cards) : [col];
    const cleanItems = items
      .map((node) => ({
        body: (node.querySelector('.entry-body, .entry-text, .prose') || node).innerText || '',
      }))
      .filter((x) => x.body.trim().length > 0);
    cleanItems.forEach((item, idx) => {
      pushEntry(`${yr}-${activeMmdd}`, yr, activeMmdd, idx, cleanItems.length, item);
    });
  });

  return results;
}

function detectCurrentDiaryMMDD() {
  const dateInput = document.querySelector('#date-picker, input[type="date"]');
  if (dateInput && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) {
    return dateInput.value.slice(5);
  }
  const monthSel = document.querySelector('#month-select, [data-role="month-select"]');
  const daySel = document.querySelector('#day-select, [data-role="day-select"]');
  if (monthSel && daySel && monthSel.value && daySel.value) {
    return `${String(monthSel.value).padStart(2, '0')}-${String(daySel.value).padStart(2, '0')}`;
  }
  const hashMatch = (location.hash || '').match(/(\d{2}-\d{2})/);
  if (hashMatch) return hashMatch[1];
  return todayISO().slice(5);
}

function jumpToDiaryDate(isoDate, year) {
  const mmdd = isoDate.slice(5);
  const [mStr, dStr] = mmdd.split('-');
  let navigated = false;

  // Try heatmap cell click first (triggers full native app state update)
  const hmCell = document.querySelector(
    `[data-mmdd="${mmdd}"], [data-date="${mmdd}"], [data-day-key="${mmdd}"]`
  );
  if (hmCell) {
    hmCell.click();
    navigated = true;
  }

  // Try month/day selects
  if (!navigated) {
    const monthSel = document.querySelector('#month-select');
    const daySel = document.querySelector('#day-select');
    if (monthSel && daySel) {
      monthSel.value = String(Number(mStr));
      monthSel.dispatchEvent(new Event('change', { bubbles: true }));
      daySel.value = String(Number(dStr));
      daySel.dispatchEvent(new Event('change', { bubbles: true }));
      navigated = true;
    }
  }

  // Try native date input
  if (!navigated) {
    const dateInput = document.querySelector('#date-picker, input[type="date"]');
    if (dateInput) {
      dateInput.value = isoDate;
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      navigated = true;
    }
  }

  // Fallback hash update
  if (!navigated) {
    location.hash = `#${mmdd}`;
  }

  closePluginModals();
  showPluginToast(`Jumped to ${formatShortDate(isoDate)}`);

  // Highlight matching year column once rendered
  setTimeout(() => {
    const targetCol = document.querySelector(`.year-col[data-year="${year}"], [data-year="${year}"]`);
    if (targetCol) {
      targetCol.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      const prevOutline = targetCol.style.outline;
      targetCol.style.outline = '2px solid #e5b869';
      setTimeout(() => {
        targetCol.style.outline = prevOutline;
      }, 2200);
    }
  }, 260);
}

/* ==========================================================================
   5. SCIENCE-BASED CLINICAL ENGINE (NIMH-LCM, IPSRT/SRM-5, ASRM, PHQ-9, PASSIVE)
   ========================================================================== */

const ASRM_ITEMS = [
  {
    q: '1. Positive Mood / Cheerfulness',
    opts: [
      '0 — Not happier or more cheerful than usual',
      '1 — Occasionally happier or more cheerful than usual',
      '2 — Often happier or more cheerful than usual',
      '3 — Happier or more cheerful than usual most of the time',
      '4 — Happier or more cheerful than usual all of the time',
    ],
  },
  {
    q: '2. Self-Confidence',
    opts: [
      '0 — Not more self-confident than usual',
      '1 — Occasionally more self-confident than usual',
      '2 — Often more self-confident than usual',
      '3 — More self-confident than usual most of the time',
      '4 — Extremely self-confident all of the time',
    ],
  },
  {
    q: '3. Need for Sleep',
    opts: [
      '0 — Do not need less sleep than usual',
      '1 — Occasionally need less sleep than usual',
      '2 — Often need less sleep than usual',
      '3 — Frequently need less sleep than usual',
      '4 — Can go all day and night without sleep and still not feel tired',
    ],
  },
  {
    q: '4. Speech / Talkativeness',
    opts: [
      '0 — Do not talk more than usual',
      '1 — Occasionally talk more than usual',
      '2 — Often talk more than usual',
      '3 — Frequently talk more than usual',
      '4 — Talk constantly and cannot be interrupted',
    ],
  },
  {
    q: '5. Activity Level',
    opts: [
      '0 — Not more active (socially, work, or physically) than usual',
      '1 — Occasionally more active than usual',
      '2 — Often more active than usual',
      '3 — Frequently more active than usual',
      '4 — Constantly active or on the go all the time',
    ],
  },
];

const PHQ9_ITEMS = [
  '1. Little interest or pleasure in doing things',
  '2. Feeling down, depressed, or hopeless',
  '3. Trouble falling or staying asleep, or sleeping too much',
  '4. Feeling tired or having little energy',
  '5. Poor appetite or overeating',
  '6. Feeling bad about yourself — or that you are a failure',
  '7. Trouble concentrating on things (reading, studying, etc.)',
  '8. Moving or speaking noticeably slowly, or being fidgety/restless',
  '9. Thoughts that you would be better off dead, or of hurting yourself',
];

const PHQ9_SCALE = ['0 — Not at all', '1 — Several days', '2 — More than half the days', '3 — Nearly every day'];

const TRIGGER_OPTIONS = [
  'Late caffeine',
  'Alcohol / substance',
  'Travel / schedule shift',
  'Skipped meals',
  'High stress / conflict',
  'Illness / physical pain',
  'Exam / deadline crunch',
];

const SYMPTOM_OPTIONS = [
  'Racing thoughts',
  'Irritability / agitation',
  'Impulsivity / overspending',
  'Pressured speech',
  'Sensory overload',
  'Anhedonia',
  'Psychomotor slowing',
  'High anxiety',
];

function classifyPolarity(elev, dep) {
  const e = Number(elev) || 0;
  const d = Number(dep) || 0;
  if (e >= 1 && d >= 1) return { label: 'Mixed Features', cls: 'bpt-badge-mixed', code: 'mixed' };
  if (e >= 2) return { label: e === 3 ? 'Severe Elevation (+3)' : 'Moderate Elevation (+2)', cls: 'bpt-badge-elev', code: 'elev' };
  if (d >= 2) return { label: d === 3 ? 'Severe Depression (-3)' : 'Moderate Depression (-2)', cls: 'bpt-badge-dep', code: 'dep' };
  if (e === 1) return { label: 'Mild Elevation (+1)', cls: 'bpt-badge-elev', code: 'elev' };
  if (d === 1) return { label: 'Mild Depression (-1)', cls: 'bpt-badge-dep', code: 'dep' };
  return { label: 'Euthymic (0)', cls: 'bpt-badge-ok', code: 'euthymic' };
}

function parseTimeMinutes(hhmm, isBedtime = false) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  let mins = h * 60 + m;
  if (isBedtime && h < 6) mins += 1440;
  return mins;
}

function computeSRM5Regularity(logsMap) {
  const dates = Object.keys(logsMap).sort().slice(-14);
  const fields = [
    { key: 'wake', bedtime: false },
    { key: 'contact', bedtime: false },
    { key: 'work', bedtime: false },
    { key: 'dinner', bedtime: false },
    { key: 'bed', bedtime: true },
  ];
  const sds = [];
  fields.forEach((f) => {
    const vals = dates
      .map((d) => parseTimeMinutes(logsMap[d]?.srm?.[f.key], f.bedtime))
      .filter((v) => v !== null);
    if (vals.length >= 3) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      sds.push(Math.sqrt(variance));
    }
  });
  if (!sds.length) return { score: null, avgDevMin: null };
  const avgDevMin = Math.round(sds.reduce((a, b) => a + b, 0) / sds.length);
  // 0 min deviation = 100 regularity; >= 120 min average SD = 0 regularity
  const score = Math.max(0, Math.min(100, Math.round(100 - (avgDevMin / 120) * 100)));
  return { score, avgDevMin };
}

function computePassiveDiarySignals(entries) {
  const byDate = {};
  const absRegex = /\b(always|never|nothing|completely|totally|everyone|nobody|impossible|ruined)\b/gi;
  entries.forEach((e) => {
    if (!byDate[e.isoDate]) {
      byDate[e.isoDate] = { words: 0, entries: 0, lateNight: 0, absolutist: 0 };
    }
    byDate[e.isoDate].words += e.words;
    byDate[e.isoDate].entries += 1;
    if (e.hour !== null && e.hour >= 0 && e.hour < 5) byDate[e.isoDate].lateNight += 1;
    const absMatches = e.text.match(absRegex);
    if (absMatches) byDate[e.isoDate].absolutist += absMatches.length;
  });

  const dates = Object.keys(byDate).sort();
  const recent14 = dates.slice(-14);
  const avgWords = recent14.length
    ? Math.round(recent14.reduce((a, d) => a + byDate[d].words, 0) / recent14.length)
    : 0;
  const lateNightCount = recent14.reduce((a, d) => a + byDate[d].lateNight, 0);
  const multiEntryDays = recent14.filter((d) => byDate[d].entries > 1).length;
  const totalWords14 = recent14.reduce((a, d) => a + byDate[d].words, 0);
  const totalAbs14 = recent14.reduce((a, d) => a + byDate[d].absolutist, 0);
  const absRate = totalWords14 > 0 ? Number(((totalAbs14 / totalWords14) * 100).toFixed(2)) : 0;

  return { byDate, avgWords, lateNightCount, multiEntryDays, absRate };
}

function evaluateClinicalAlerts(data, passiveSignals) {
  const alerts = [];
  const logs = data.logs || {};
  const sortedDates = Object.keys(logs).sort();
  const recent = sortedDates.slice(-16);

  // 14-day sleep baseline (prior to most recent 2 days when enough data exists)
  const sleepEntries = recent.filter((d) => typeof logs[d].sleepHours === 'number' && logs[d].sleepHours > 0);
  let sleepBaseline = null;
  if (sleepEntries.length >= 4) {
    const basePool = sleepEntries.slice(0, Math.max(2, sleepEntries.length - 2));
    sleepBaseline = basePool.reduce((a, d) => a + logs[d].sleepHours, 0) / basePool.length;
    const lastTwo = sleepEntries.slice(-2);
    if (
      lastTwo.length === 2 &&
      lastTwo.every((d) => sleepBaseline - logs[d].sleepHours >= 2.0)
    ) {
      const wired = lastTwo.some((d) => logs[d].sleepNeed === 'decreased' || (logs[d].elevation || 0) >= 1);
      alerts.push({
        level: wired ? 'danger' : 'warn',
        title: wired
          ? 'Sleep Drop + Activation Prodrome Flag'
          : 'Consecutive Sleep Drop Below Baseline',
        detail: `Sleep dropped >= 2h below your ${sleepBaseline.toFixed(1)}h rolling baseline for 2+ nights (${lastTwo
          .map((d) => `${d}: ${logs[d].sleepHours}h`)
          .join(', ')}). Consider prioritizing circadian stabilization and checking in with your care plan.`,
      });
    }
  }

  // Severe state or Safety Plan trigger
  const latestDate = sortedDates[sortedDates.length - 1];
  const latest = latestDate ? logs[latestDate] : null;
  if (latest && (Number(latest.elevation) === 3 || Number(latest.depression) === 3)) {
    alerts.push({
      level: 'danger',
      title: `Severe State Logged (${latestDate})`,
      detail: 'A Level 3 (Severe) rating was logged. Your encrypted Stanley-Brown Safety Plan is available in the Safety Plan tab.',
      openSafety: true,
    });
  } else if (latest && Number(latest.elevation) >= 1 && Number(latest.depression) >= 1) {
    alerts.push({
      level: 'warn',
      title: `Mixed Features Detected (${latestDate})`,
      detail: `Simultaneous Elevation (+${latest.elevation}) and Depression (-${latest.depression}) logged. Monitor sleep, agitation, and impulses closely.`,
    });
  }

  // Latest ASRM / PHQ-9 threshold flags
  const screeners = [...(data.screeners || [])].sort((a, b) => a.date.localeCompare(b.date));
  const lastASRM = [...screeners].reverse().find((s) => s.type === 'ASRM');
  if (lastASRM && lastASRM.score >= 6) {
    alerts.push({
      level: 'warn',
      title: `Elevated ASRM Score (${lastASRM.score}/20 on ${lastASRM.date})`,
      detail: 'ASRM >= 6 indicates a high probability of hypomanic or manic symptoms.',
    });
  }
  const lastPHQ = [...screeners].reverse().find((s) => s.type === 'PHQ9');
  if (lastPHQ && (lastPHQ.score >= 10 || (lastPHQ.answers && lastPHQ.answers[8] > 0))) {
    alerts.push({
      level: lastPHQ.answers && lastPHQ.answers[8] > 0 ? 'danger' : 'warn',
      title: `PHQ-9 Clinical Flag (${lastPHQ.score}/27 on ${lastPHQ.date})`,
      detail:
        lastPHQ.answers && lastPHQ.answers[8] > 0
          ? 'Item 9 (self-harm thoughts) was endorsed. Please review your Safety Plan and reach out to your clinician or support contact.'
          : 'PHQ-9 >= 10 indicates moderate-to-severe depressive symptoms.',
      openSafety: Boolean(lastPHQ.answers && lastPHQ.answers[8] > 0),
    });
  }

  // Passive writing burst alert (00:00-04:59 posts)
  if (passiveSignals && passiveSignals.lateNightCount >= 3) {
    alerts.push({
      level: 'warn',
      title: 'Passive Signal: Late-Night Writing Drift',
      detail: `${passiveSignals.lateNightCount} diary entries were written between 12:00 AM and 5:00 AM in your recent 14-day window.`,
    });
  }

  return { alerts, sleepBaseline };
}

/* ==========================================================================
   6. SIMPLE ENTRY INDEX MODAL (100% NON-CLINICAL)
   ========================================================================== */

function ensureModalHost(id) {
  let backdrop = document.getElementById(id);
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = id;
    backdrop.className = 'plug-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closePluginModals();
    });
    document.body.appendChild(backdrop);
  }
  return backdrop;
}

function closePluginModals() {
  document.querySelectorAll('.plug-backdrop.is-open').forEach((el) => el.classList.remove('is-open'));
}

function openSimpleIndexModal() {
  closePluginModals();
  const backdrop = ensureModalHost('pdx-modal-backdrop');
  backdrop.classList.add('is-open');
  renderSimpleIndexModal();
}

function renderSimpleIndexModal() {
  const backdrop = ensureModalHost('pdx-modal-backdrop');
  const allEntries = scanAllDiaryEntries();

  // Build years list and tag directory
  const yearSet = new Set();
  const tagMap = new Map();
  allEntries.forEach((e) => {
    yearSet.add(e.year);
    e.tags.forEach((tag) => {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(e);
    });
  });
  const years = Array.from(yearSet).sort((a, b) => b.localeCompare(a));

  // Apply search, year, and tag filters
  const q = pluginState.indexSearch.trim().toLowerCase();
  const activeTag = pluginState.indexTag.trim().toLowerCase();
  let filtered = allEntries.filter((e) => {
    if (pluginState.indexYear !== 'all' && e.year !== pluginState.indexYear) return false;
    if (activeTag && !e.tags.includes(activeTag)) return false;
    if (q) {
      const hay = `${e.isoDate} ${e.title} ${e.text} ${e.tags.map((t) => '#' + t).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort
  if (pluginState.indexSort === 'oldest') {
    filtered.sort((a, b) => a.isoDate.localeCompare(b.isoDate) || a.entryIndex - b.entryIndex);
  } else if (pluginState.indexSort === 'words') {
    filtered.sort((a, b) => b.words - a.words);
  } else {
    filtered.sort((a, b) => b.isoDate.localeCompare(a.isoDate) || b.entryIndex - a.entryIndex);
  }

  const uniqueDatesCount = new Set(allEntries.map((e) => e.isoDate)).size;

  const entriesHtml = filtered.length
    ? filtered
        .map(
          (e) => `
      <div class="pdx-row">
        <div class="pdx-row-top">
          <div class="pdx-date-badge">
            <span>${esc(e.isoDate)}</span>
            ${e.totalInYear > 1 ? `<span class="pdx-entry-num">#${e.entryIndex} of ${e.totalInYear}</span>` : ''}
            ${e.title ? `<span style="color:var(--plug-text);font-weight:600;">· ${esc(e.title)}</span>` : ''}
          </div>
          <button type="button" class="plug-btn plug-btn-sm pdx-jump-btn" data-iso="${esc(e.isoDate)}" data-year="${esc(e.year)}">Jump →</button>
        </div>
        <p class="pdx-excerpt">${esc(e.excerpt)}</p>
        <div class="pdx-meta-line">
          <span>${e.words.toLocaleString()} words</span>
          ${e.tags.length ? '<span>·</span>' : ''}
          ${e.tags
            .map(
              (t) =>
                `<button type="button" class="pdx-tag-chip ${activeTag === t ? 'is-active' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`
            )
            .join('')}
        </div>
      </div>`
        )
        .join('')
    : `<div class="pdx-empty">No matching entries found in the loaded diary cache. Unlock your vault or browse dates to populate entries, or clear your filter.</div>`;

  const sortedTags = Array.from(tagMap.entries())
    .filter(([tag]) => !q || tag.includes(q.replace(/^#/, '')))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const tagsHtml = sortedTags.length
    ? sortedTags
        .map(([tag, list]) => {
          const sortedDates = Array.from(new Set(list.map((x) => x.isoDate))).sort((a, b) => b.localeCompare(a));
          const spanYears = Array.from(new Set(list.map((x) => x.year))).sort();
          const yearSpanLabel =
            spanYears.length > 1 ? `${spanYears[0]}–${spanYears[spanYears.length - 1]}` : spanYears[0] || '';
          return `
        <div class="pdx-row">
          <div class="pdx-row-top">
            <div class="pdx-date-badge">
              <span>#${esc(tag)}</span>
              <span class="pdx-entry-num">${list.length} ${list.length === 1 ? 'entry' : 'entries'}${yearSpanLabel ? ` · ${yearSpanLabel}` : ''}</span>
            </div>
            <button type="button" class="plug-btn plug-btn-sm pdx-filter-tag-btn" data-tag="${esc(tag)}">Filter Entries</button>
          </div>
          <div class="pdx-date-chips">
            ${sortedDates
              .slice(0, 14)
              .map(
                (iso) =>
                  `<button type="button" class="pdx-date-chip pdx-jump-btn" data-iso="${esc(iso)}" data-year="${esc(iso.slice(0, 4))}">${esc(iso)}</button>`
              )
              .join('')}
            ${sortedDates.length > 14 ? `<span class="pdx-entry-num">+${sortedDates.length - 14} more</span>` : ''}
          </div>
        </div>`;
        })
        .join('')
    : `<div class="pdx-empty">No #tags found yet. Add #tags anywhere inside your diary entries (e.g., #zine, #travel, #study) to organize them here automatically.</div>`;

  backdrop.innerHTML = `
    <div class="plug-modal" role="dialog" aria-modal="true" aria-label="Entry Index">
      <div class="plug-header">
        <div class="plug-title-wrap">
          <h2>Entry Index</h2>
          <p class="plug-subtitle">Simple directory of diary entries, stacked notes, and #tags</p>
        </div>
        <div class="plug-header-actions">
          <button type="button" class="plug-btn plug-btn-sm" id="pdx-close-btn">Close</button>
        </div>
      </div>

      <div class="plug-tabs">
        <button type="button" class="plug-tab ${pluginState.indexTab === 'entries' ? 'is-active' : ''}" data-pdx-tab="entries">All Entries (${filtered.length})</button>
        <button type="button" class="plug-tab ${pluginState.indexTab === 'tags' ? 'is-active' : ''}" data-pdx-tab="tags">By #Tag (${tagMap.size})</button>
      </div>

      <div class="plug-body">
        <div class="pdx-toolbar">
          <input type="search" id="pdx-search-input" class="plug-input" placeholder="Search entries, dates (YYYY-MM-DD), or #tags..." value="${esc(pluginState.indexSearch)}" />
          <select id="pdx-year-select" class="plug-select">
            <option value="all" ${pluginState.indexYear === 'all' ? 'selected' : ''}>All Years</option>
            ${years.map((y) => `<option value="${esc(y)}" ${pluginState.indexYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
          </select>
          <select id="pdx-sort-select" class="plug-select">
            <option value="newest" ${pluginState.indexSort === 'newest' ? 'selected' : ''}>Newest First</option>
            <option value="oldest" ${pluginState.indexSort === 'oldest' ? 'selected' : ''}>Oldest First</option>
            <option value="words" ${pluginState.indexSort === 'words' ? 'selected' : ''}>Most Words</option>
          </select>
        </div>

        <div class="plug-stat-strip">
          <span><strong>${allEntries.length}</strong> Entries</span>
          <span>·</span>
          <span><strong>${uniqueDatesCount}</strong> Dates</span>
          <span>·</span>
          <span><strong>${tagMap.size}</strong> Tags</span>
          ${
            activeTag
              ? `<span>·</span><span>Active Tag: <strong>#${esc(activeTag)}</strong> <button type="button" id="pdx-clear-tag" class="plug-btn plug-btn-sm" style="margin-left:6px;">Clear</button></span>`
              : ''
          }
        </div>

        <div class="pdx-list">
          ${pluginState.indexTab === 'tags' ? tagsHtml : entriesHtml}
        </div>
      </div>
    </div>
  `;

  backdrop.querySelector('#pdx-close-btn').addEventListener('click', closePluginModals);
  backdrop.querySelectorAll('[data-pdx-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pluginState.indexTab = btn.getAttribute('data-pdx-tab');
      renderSimpleIndexModal();
    });
  });

  const searchInput = backdrop.querySelector('#pdx-search-input');
  searchInput.addEventListener('input', (e) => {
    pluginState.indexSearch = e.target.value;
    renderSimpleIndexModal();
    const fresh = document.getElementById('pdx-search-input');
    if (fresh) {
      fresh.focus();
      fresh.setSelectionRange(fresh.value.length, fresh.value.length);
    }
  });

  backdrop.querySelector('#pdx-year-select').addEventListener('change', (e) => {
    pluginState.indexYear = e.target.value;
    renderSimpleIndexModal();
  });

  backdrop.querySelector('#pdx-sort-select').addEventListener('change', (e) => {
    pluginState.indexSort = e.target.value;
    renderSimpleIndexModal();
  });

  const clearTagBtn = backdrop.querySelector('#pdx-clear-tag');
  if (clearTagBtn) {
    clearTagBtn.addEventListener('click', () => {
      pluginState.indexTag = '';
      renderSimpleIndexModal();
    });
  }

  backdrop.querySelectorAll('.pdx-tag-chip, .pdx-filter-tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.getAttribute('data-tag');
      pluginState.indexTag = pluginState.indexTag === t && pluginState.indexTab === 'entries' ? '' : t;
      pluginState.indexTab = 'entries';
      renderSimpleIndexModal();
    });
  });

  backdrop.querySelectorAll('.pdx-jump-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      jumpToDiaryDate(btn.getAttribute('data-iso'), btn.getAttribute('data-year'));
    });
  });
}

// === END OF PART 1 — PASTE PART 2 DIRECTLY BELOW THIS LINE ===
/* ==========================================================================
   7. SVG TRAJECTORY & PERPETUAL SEASONAL OVERLAY CHARTS
   ========================================================================== */

function buildDateWindow(endIso, days) {
  const arr = [];
  for (let i = days - 1; i >= 0; i--) {
    arr.push(shiftISO(endIso, -i));
  }
  return arr;
}

function renderDualAxisSVG(data, rangeDays = 30) {
  const endIso = todayISO();
  const dates = buildDateWindow(endIso, rangeDays);
  const logs = data.logs || {};
  const hasAny = dates.some((d) => logs[d]);

  if (!hasAny) {
    return `<div class="pdx-empty">Log at least 1–2 days in the Daily Log tab to generate your dual-axis mood, sleep, and milestone chart.</div>`;
  }

  const W = Math.max(660, rangeDays * 14);
  const H = 250;
  const padL = 44;
  const padR = 44;
  const padT = 22;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xAt = (idx) => padL + (dates.length > 1 ? (idx / (dates.length - 1)) * plotW : plotW / 2);
  // Mood axis: +3 (top) to -3 (bottom)
  const yMood = (val) => padT + ((3 - val) / 6) * plotH;
  // Sleep axis: 12h (top) to 0h (bottom)
  const ySleep = (hrs) => padT + ((12 - Math.max(0, Math.min(12, hrs))) / 12) * plotH;

  let gridHtml = '';
  [-3, -2, -1, 0, 1, 2, 3].forEach((m) => {
    const y = yMood(m).toFixed(1);
    const stroke = m === 0 ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.08)';
    gridHtml += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${stroke}" stroke-dasharray="${m === 0 ? '' : '3 3'}" />`;
    gridHtml += `<text x="${padL - 8}" y="${Number(y) + 4}" text-anchor="end" fill="#9aa5b8" font-size="10">${m > 0 ? '+' + m : m}</text>`;
  });

  [0, 4, 8, 12].forEach((h) => {
    const y = ySleep(h).toFixed(1);
    gridHtml += `<text x="${W - padR + 8}" y="${Number(y) + 4}" text-anchor="start" fill="#34d399" font-size="10">${h}h</text>`;
  });

  // X-axis date ticks
  const step = rangeDays > 45 ? 10 : 5;
  dates.forEach((d, idx) => {
    if (idx === 0 || idx === dates.length - 1 || idx % step === 0) {
      const x = xAt(idx).toFixed(1);
      gridHtml += `<text x="${x}" y="${H - 10}" text-anchor="middle" fill="#9aa5b8" font-size="10">${d.slice(5)}</text>`;
    }
  });

  // Milestone vertical markers
  let milestoneHtml = '';
  (data.milestones || []).forEach((ms) => {
    const idx = dates.indexOf(ms.date);
    if (idx === -1) return;
    const x = xAt(idx).toFixed(1);
    milestoneHtml += `
      <g>
        <line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="#e5b869" stroke-width="1.5" stroke-dasharray="4 3" />
        <rect x="${Number(x) - 3}" y="${padT - 14}" width="6" height="6" rx="1" fill="#e5b869"><title>${esc(ms.date)}: ${esc(ms.label)}</title></rect>
      </g>`;
  });

  // Build polylines & points
  const elevPts = [];
  const depPts = [];
  const sleepPts = [];
  let dotsHtml = '';

  dates.forEach((d, idx) => {
    const log = logs[d];
    if (!log) return;
    const x = xAt(idx).toFixed(1);
    const e = Number(log.elevation) || 0;
    const dep = Number(log.depression) || 0;
    const ye = yMood(e).toFixed(1);
    const yd = yMood(-dep).toFixed(1);

    elevPts.push(`${x},${ye}`);
    depPts.push(`${x},${yd}`);

    const isMixed = e >= 1 && dep >= 1;
    if (isMixed) {
      dotsHtml += `<line x1="${x}" y1="${ye}" x2="${x}" y2="${yd}" stroke="#c084fc" stroke-width="3" opacity="0.55" />`;
    }
    dotsHtml += `<circle cx="${x}" cy="${ye}" r="3.5" fill="${isMixed ? '#c084fc' : '#f59e0b'}"><title>${esc(d)} · Elevation +${e}</title></circle>`;
    dotsHtml += `<circle cx="${x}" cy="${yd}" r="3.5" fill="${isMixed ? '#c084fc' : '#60a5fa'}"><title>${esc(d)} · Depression -${dep}</title></circle>`;

    if (typeof log.sleepHours === 'number' && log.sleepHours > 0) {
      const ys = ySleep(log.sleepHours).toFixed(1);
      sleepPts.push(`${x},${ys}`);
      const wiredRing = log.sleepNeed === 'decreased' ? ' stroke="#f87171" stroke-width="2"' : '';
      dotsHtml += `<circle cx="${x}" cy="${ys}" r="3" fill="#34d399"${wiredRing}><title>${esc(d)} · Sleep ${log.sleepHours}h (${esc(log.sleepNeed || 'normal')})</title></circle>`;
    }
  });

  const makePath = (pts, color, width = 2, dash = '') =>
    pts.length >= 2
      ? `<polyline fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" points="${pts.join(' ')}" />`
      : '';

  return `
    <div class="bpt-chart-box">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;max-width:100%;height:auto;">
        ${gridHtml}
        ${milestoneHtml}
        ${makePath(sleepPts, '#34d399', 1.8, '5 3')}
        ${makePath(elevPts, '#f59e0b', 2.2)}
        ${makePath(depPts, '#60a5fa', 2.2)}
        ${dotsHtml}
      </svg>
      <div class="bpt-chart-legend">
        <span><i class="bpt-legend-dot" style="background:#f59e0b"></i>Elevation (0 to +3)</span>
        <span><i class="bpt-legend-dot" style="background:#60a5fa"></i>Depression (0 to -3)</span>
        <span><i class="bpt-legend-dot" style="background:#c084fc"></i>Mixed State Connector</span>
        <span><i class="bpt-legend-dot" style="background:#34d399"></i>Sleep Hours (Right Axis; red ring = decreased need)</span>
        <span><i class="bpt-legend-dot" style="background:#e5b869"></i>Med / Event Milestone</span>
      </div>
    </div>
  `;
}

function renderSeasonalOverlaySVG(data) {
  const logs = data.logs || {};
  const yearsSet = new Set(Object.keys(logs).map((d) => d.slice(0, 4)));
  const years = Array.from(yearsSet).sort().slice(-4);
  if (!years.length) {
    return `<div class="pdx-empty">No multi-year mood data logged yet. As logs accumulate across years, this chart overlays the same 60-day seasonal window year-over-year.</div>`;
  }

  // 60-day window: -30 to +29 days around today's MM-DD
  const anchor = todayISO();
  const offsets = [];
  for (let o = -30; o <= 29; o++) offsets.push(o);
  const mmddLabels = offsets.map((o) => shiftISO(anchor, o).slice(5));

  const W = 660;
  const H = 190;
  const padL = 40;
  const padR = 20;
  const padT = 18;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xAt = (i) => padL + (i / (offsets.length - 1)) * plotW;
  const yNet = (v) => padT + ((3 - v) / 6) * plotH;

  let grid = '';
  [-3, 0, 3].forEach((v) => {
    const y = yNet(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${v === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)'}" />`;
    grid += `<text x="${padL - 8}" y="${Number(y) + 4}" text-anchor="end" fill="#9aa5b8" font-size="10">${v > 0 ? '+' + v : v}</text>`;
  });
  [0, 15, 30, 45, 59].forEach((idx) => {
    const x = xAt(idx).toFixed(1);
    grid += `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="#9aa5b8" font-size="10">${mmddLabels[idx]}</text>`;
  });
  // Today vertical reference line
  const todayX = xAt(30).toFixed(1);
  grid += `<line x1="${todayX}" y1="${padT}" x2="${todayX}" y2="${H - padB}" stroke="rgba(229,184,105,0.45)" stroke-dasharray="3 3" />`;

  const palette = ['#94a3b8', '#60a5fa', '#c084fc', '#e5b869'];
  let seriesHtml = '';
  let legendHtml = '';

  years.forEach((yr, yIdx) => {
    const color = palette[yIdx % palette.length];
    const pts = [];
    let dots = '';
    mmddLabels.forEach((mmdd, i) => {
      const log = logs[`${yr}-${mmdd}`];
      if (!log) return;
      const net = (Number(log.elevation) || 0) - (Number(log.depression) || 0);
      const x = xAt(i).toFixed(1);
      const y = yNet(net).toFixed(1);
      pts.push(`${x},${y}`);
      dots += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"><title>${yr}-${mmdd} · Elev +${log.elevation || 0} / Dep -${log.depression || 0}</title></circle>`;
    });
    if (pts.length >= 2) {
      seriesHtml += `<polyline fill="none" stroke="${color}" stroke-width="${yIdx === years.length - 1 ? 2.4 : 1.6}" opacity="${yIdx === years.length - 1 ? 1 : 0.72}" points="${pts.join(' ')}" />`;
    }
    seriesHtml += dots;
    legendHtml += `<span><i class="bpt-legend-dot" style="background:${color}"></i>${esc(yr)} (${pts.length} logs)</span>`;
  });

  return `
    <div class="bpt-chart-box">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;max-width:100%;height:auto;">
        ${grid}
        ${seriesHtml}
      </svg>
      <div class="bpt-chart-legend">
        ${legendHtml}
        <span style="margin-left:auto;">Window: ${mmddLabels[0]} to ${mmddLabels[mmddLabels.length - 1]} (±30d around today)</span>
      </div>
    </div>
  `;
}

/* ==========================================================================
   8. POPUP-BLOCKER-PROOF IFRAME CLINICAL PRINT ENGINE
   ========================================================================== */

function printClinicalSummary(data) {
  const logs = data.logs || {};
  const dates = Object.keys(logs).sort().reverse();
  const recent90 = dates.slice(0, 90);
  const srm = computeSRM5Regularity(logs);
  const passive = computePassiveDiarySignals(scanAllDiaryEntries());
  const { alerts, sleepBaseline } = evaluateClinicalAlerts(data, passive);

  const sleepVals = recent90.map((d) => logs[d].sleepHours).filter((v) => typeof v === 'number' && v > 0);
  const avgSleep = sleepVals.length ? (sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length).toFixed(1) : 'N/A';
  const mixedCount = recent90.filter((d) => (logs[d].elevation || 0) >= 1 && (logs[d].depression || 0) >= 1).length;
  const elevDays = recent90.filter((d) => (logs[d].elevation || 0) >= 1).length;
  const depDays = recent90.filter((d) => (logs[d].depression || 0) >= 1).length;
  const medLogs = recent90.filter((d) => logs[d].medStatus && logs[d].medStatus !== 'na');
  const medTaken = medLogs.filter((d) => logs[d].medStatus === 'taken').length;
  const medRate = medLogs.length ? `${Math.round((medTaken / medLogs.length) * 100)}% (${medTaken}/${medLogs.length})` : 'N/A';

  const screeners = [...(data.screeners || [])].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const milestones = [...(data.milestones || [])].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Clinical Mood & Sleep Summary — ${todayISO()}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; margin: 24px; line-height: 1.45; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 18px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  .meta { color: #4b5563; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
  .stat { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; }
  .stat span { display: block; color: #6b7280; font-size: 10px; text-transform: uppercase; }
  .stat strong { font-size: 14px; }
  .alert { border-left: 3px solid #dc2626; background: #fef2f2; padding: 8px 10px; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #d1d5db; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 700; }
  @media print { body { margin: 12px; } }
</style>
</head>
<body>
  <h1>Clinical Mood, Sleep & Circadian Summary</h1>
  <div class="meta">Generated: ${esc(todayISO())} · Window: Last ${recent90.length} logged days · Scale: NIMH-LCM-p Dual-Axis (0 to ±3)</div>

  <div class="grid">
    <div class="stat"><span>Avg Sleep (90d)</span><strong>${esc(avgSleep)} hrs</strong></div>
    <div class="stat"><span>14d Sleep Baseline</span><strong>${sleepBaseline ? sleepBaseline.toFixed(1) + ' hrs' : 'N/A'}</strong></div>
    <div class="stat"><span>Med Adherence</span><strong>${esc(medRate)}</strong></div>
    <div class="stat"><span>SRM-5 Regularity</span><strong>${srm.score !== null ? srm.score + '/100 (±' + srm.avgDevMin + 'm)' : 'N/A'}</strong></div>
  </div>
  <div class="meta">Days with Elevation: <strong>${elevDays}</strong> · Days with Depression: <strong>${depDays}</strong> · Mixed Feature Days: <strong>${mixedCount}</strong></div>

  ${
    alerts.length
      ? `<h2>Active Clinical / Prodrome Flags</h2>${alerts
          .map((a) => `<div class="alert"><strong>${esc(a.title)}:</strong> ${esc(a.detail)}</div>`)
          .join('')}`
      : ''
  }

  ${
    milestones.length
      ? `<h2>Medication & Care Milestones</h2>
         <table><thead><tr><th>Date</th><th>Milestone</th><th>Notes</th></tr></thead><tbody>
         ${milestones.map((m) => `<tr><td>${esc(m.date)}</td><td>${esc(m.label)}</td><td>${esc(m.note || '')}</td></tr>`).join('')}
         </tbody></table>`
      : ''
  }

  ${
    screeners.length
      ? `<h2>Validated Clinical Screeners (ASRM & PHQ-9)</h2>
         <table><thead><tr><th>Date</th><th>Scale</th><th>Score</th><th>Interpretation</th><th>Notes</th></tr></thead><tbody>
         ${screeners
           .map((s) => {
             const interp =
               s.type === 'ASRM'
                 ? s.score >= 6
                   ? 'High probability of hypomania/mania (>=6)'
                   : 'Below manic cutoff (<6)'
                 : s.score >= 20
                 ? 'Severe depression'
                 : s.score >= 15
                 ? 'Moderately severe'
                 : s.score >= 10
                 ? 'Moderate'
                 : s.score >= 5
                 ? 'Mild'
                 : 'Minimal';
             return `<tr><td>${esc(s.date)}</td><td>${esc(s.type)}</td><td><strong>${s.score}/${s.type === 'ASRM' ? 20 : 27}</strong></td><td>${interp}</td><td>${esc(s.note || '')}</td></tr>`;
           })
           .join('')}
         </tbody></table>`
      : ''
  }

  <h2>Recent Daily Logs (Last 30 Entries)</h2>
  <table>
    <thead><tr><th>Date</th><th>Polarity</th><th>Sleep / Need</th><th>Meds / PRN</th><th>Symptoms & Triggers</th><th>Note</th></tr></thead>
    <tbody>
      ${dates
        .slice(0, 30)
        .map((d) => {
          const l = logs[d];
          const pol = classifyPolarity(l.elevation, l.depression);
          const tags = [...(l.symptoms || []), ...(l.triggers || [])].join(', ');
          return `<tr>
            <td>${esc(d)}</td>
            <td><strong>${esc(pol.label)}</strong><br/>Elev +${l.elevation || 0} / Dep -${l.depression || 0}</td>
            <td>${l.sleepHours ? esc(l.sleepHours) + 'h' : '—'}<br/>${esc(l.sleepNeed || 'normal')}</td>
            <td>${esc((l.medStatus || 'na').toUpperCase())}${l.prn ? '<br/>PRN: ' + esc(l.prn) : ''}</td>
            <td>${esc(tags || '—')}</td>
            <td>${esc(l.note || '')}</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table>
</body>
</html>`;

  try {
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '0',
      height: '0',
      border: '0',
      visibility: 'hidden',
    });
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => iframe.remove(), 2000);
      } catch {
        iframe.remove();
        downloadClinicalHtmlFallback(html);
      }
    }, 300);
  } catch {
    downloadClinicalHtmlFallback(html);
  }
}

function downloadClinicalHtmlFallback(html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clinical-summary-${todayISO()}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  showPluginToast('Downloaded printable clinical summary (.html)');
}

/* ==========================================================================
   9. SCIENCE-BASED BIPOLAR TRACKER MODAL UI
   ========================================================================== */

async function openBipolarTrackerModal(defaultTab = null) {
  closePluginModals();
  if (defaultTab) pluginState.activeTrackerTab = defaultTab;
  const backdrop = ensureModalHost('bpt-modal-backdrop');
  backdrop.classList.add('is-open');
  backdrop.innerHTML = `<div class="plug-modal"><div class="plug-body"><p style="text-align:center;padding:36px;color:var(--plug-muted);">Loading encrypted tracker store…</p></div></div>`;
  await loadTrackerStore();
  renderBipolarTrackerModal();
}

function renderBipolarTrackerModal() {
  const backdrop = ensureModalHost('bpt-modal-backdrop');

  // Lock gate if tracker is passphrase-encrypted and locked
  if (pluginState.lockedEnvelope) {
    backdrop.innerHTML = `
      <div class="plug-modal" role="dialog" aria-modal="true" aria-label="Unlock Bipolar Tracker">
        <div class="plug-header">
          <div class="plug-title-wrap">
            <h2>Mood & Bipolar Tracker (Locked)</h2>
            <p class="plug-subtitle">Encrypted with AES-256-GCM · ${esc(pluginState.syncStatus)}</p>
          </div>
          <button type="button" class="plug-btn plug-btn-sm" id="bpt-close-btn">Close</button>
        </div>
        <div class="plug-body">
          <div class="plug-card bpt-lock-screen">
            <h3 style="margin:0 0 8px;">Enter Tracker Passphrase</h3>
            <p style="font-size:0.83rem;color:var(--plug-muted);margin:0 0 14px;">
              Your clinical mood logs, screeners, and Stanley-Brown safety plan are encrypted in browser storage and your private vault.
            </p>
            <input type="password" id="bpt-unlock-pass" class="plug-input" placeholder="Tracker passphrase" autocomplete="current-password" />
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;">
              <button type="button" id="bpt-unlock-btn" class="plug-btn plug-btn-primary">Unlock Tracker</button>
            </div>
            <p id="bpt-unlock-err" style="color:var(--plug-danger);font-size:0.8rem;margin:10px 0 0;"></p>
          </div>
        </div>
      </div>`;
    backdrop.querySelector('#bpt-close-btn').addEventListener('click', closePluginModals);
    const tryUnlock = async () => {
      const pw = backdrop.querySelector('#bpt-unlock-pass').value;
      if (!pw) return;
      try {
        const plain = await bptCrypto.decryptJSON(pluginState.lockedEnvelope, pw);
        pluginState.passphrase = pw;
        pluginState.trackerData = Object.assign(createEmptyTrackerData(), plain);
        pluginState.lockedEnvelope = null;
        renderBipolarTrackerModal();
      } catch {
        backdrop.querySelector('#bpt-unlock-err').textContent = 'Incorrect passphrase. Please try again.';
      }
    };
    backdrop.querySelector('#bpt-unlock-btn').addEventListener('click', tryUnlock);
    backdrop.querySelector('#bpt-unlock-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryUnlock();
    });
    return;
  }

  const data = pluginState.trackerData;
  const passive = computePassiveDiarySignals(scanAllDiaryEntries());
  const { alerts, sleepBaseline } = evaluateClinicalAlerts(data, passive);
  const srm = computeSRM5Regularity(data.logs || {});

  const alertsHtml = alerts
    .map(
      (a) => `
      <div class="bpt-alert-banner ${a.level === 'warn' ? 'is-warn' : ''}">
        <strong>${esc(a.title)}:</strong> ${esc(a.detail)}
        ${
          a.openSafety
            ? `<div style="margin-top:8px;"><button type="button" class="plug-btn plug-btn-sm plug-btn-danger bpt-jump-safety">Open Safety Plan</button></div>`
            : ''
        }
      </div>`
    )
    .join('');

  let tabBody = '';
  if (pluginState.activeTrackerTab === 'daily') {
    tabBody = renderDailyLogTab(data, sleepBaseline, srm);
  } else if (pluginState.activeTrackerTab === 'charts') {
    tabBody = renderChartsTab(data, passive, srm);
  } else if (pluginState.activeTrackerTab === 'screeners') {
    tabBody = renderScreenersTab(data);
  } else {
    tabBody = renderSafetyAndVaultTab(data);
  }

  backdrop.innerHTML = `
    <div class="plug-modal" role="dialog" aria-modal="true" aria-label="Bipolar Mood Tracker">
      <div class="plug-header">
        <div class="plug-title-wrap">
          <h2>Bipolar & Circadian Tracker</h2>
          <p class="plug-subtitle">NIMH-LCM Dual-Axis · IPSRT/SRM-5 · ASRM/PHQ-9 · ${esc(pluginState.syncStatus)}${pluginState.passphrase ? ' · 🔒 Encrypted' : ''}</p>
        </div>
        <div class="plug-header-actions">
          <button type="button" class="plug-btn plug-btn-sm" id="bpt-print-btn">Print Summary</button>
          <button type="button" class="plug-btn plug-btn-sm" id="bpt-close-btn">Close</button>
        </div>
      </div>

      <div class="plug-tabs">
        <button type="button" class="plug-tab ${pluginState.activeTrackerTab === 'daily' ? 'is-active' : ''}" data-bpt-tab="daily">Daily Log</button>
        <button type="button" class="plug-tab ${pluginState.activeTrackerTab === 'charts' ? 'is-active' : ''}" data-bpt-tab="charts">Charts & Signals</button>
        <button type="button" class="plug-tab ${pluginState.activeTrackerTab === 'screeners' ? 'is-active' : ''}" data-bpt-tab="screeners">ASRM & PHQ-9</button>
        <button type="button" class="plug-tab ${pluginState.activeTrackerTab === 'safety' ? 'is-active' : ''}" data-bpt-tab="safety">Safety Plan & Vault</button>
      </div>

      <div class="plug-body">
        ${alertsHtml}
        ${tabBody}
      </div>
    </div>
  `;

  backdrop.querySelector('#bpt-close-btn').addEventListener('click', closePluginModals);
  backdrop.querySelector('#bpt-print-btn').addEventListener('click', () => printClinicalSummary(data));
  backdrop.querySelectorAll('[data-bpt-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pluginState.activeTrackerTab = btn.getAttribute('data-bpt-tab');
      renderBipolarTrackerModal();
    });
  });
  backdrop.querySelectorAll('.bpt-jump-safety').forEach((btn) => {
    btn.addEventListener('click', () => {
      pluginState.activeTrackerTab = 'safety';
      renderBipolarTrackerModal();
    });
  });

  if (pluginState.activeTrackerTab === 'daily') bindDailyLogTab(backdrop, data);
  else if (pluginState.activeTrackerTab === 'charts') bindChartsTab(backdrop, data);
  else if (pluginState.activeTrackerTab === 'screeners') bindScreenersTab(backdrop, data);
  else bindSafetyAndVaultTab(backdrop, data);
}

/* --- TAB 1: DAILY LOG --- */

function renderDailyLogTab(data, sleepBaseline, srm) {
  const date = pluginState.selectedDate || todayISO();
  const existing = data.logs[date] || {};
  const elev = Number(existing.elevation) || 0;
  const dep = Number(existing.depression) || 0;
  const pol = classifyPolarity(elev, dep);
  const syms = new Set(existing.symptoms || []);
  const trigs = new Set(existing.triggers || []);
  const prodChecks = new Set(existing.prodromes || []);
  const srmVals = existing.srm || {};

  const elevLabels = [
    ['0', 'Baseline'],
    ['+1', 'Mild · Intact'],
    ['+2', 'Mod · Struggling'],
    ['+3', 'Severe · Impaired'],
  ];
  const depLabels = [
    ['0', 'Baseline'],
    ['-1', 'Mild · Intact'],
    ['-2', 'Mod · Struggling'],
    ['-3', 'Severe · Impaired'],
  ];

  const personalProdromes = [
    ...(data.prodromes?.elevation || []),
    ...(data.prodromes?.depression || []),
  ];

  return `
    <div class="plug-stat-strip">
      <span>Logged Date: <strong>${esc(date)}</strong></span>
      <span>·</span>
      <span class="bpt-badge ${pol.cls}">${esc(pol.label)}</span>
      ${sleepBaseline ? `<span>·</span><span>14d Sleep Baseline: <strong>${sleepBaseline.toFixed(1)}h</strong></span>` : ''}
      ${srm.score !== null ? `<span>·</span><span>SRM-5 Regularity: <strong>${srm.score}/100</strong></span>` : ''}
    </div>

    <div class="plug-card">
      <div class="plug-card-title">
        <span>1. Date & Dual-Axis Polarity (NIMH-LCM-p)</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <button type="button" class="plug-btn plug-btn-sm" id="bpt-prev-day">←</button>
          <input type="date" id="bpt-date-input" class="plug-input" style="width:auto;padding:4px 8px;" value="${esc(date)}" />
          <button type="button" class="plug-btn plug-btn-sm" id="bpt-next-day">→</button>
        </div>
      </div>

      <div class="plug-grid-2">
        <div>
          <label class="bpt-field-label">Elevation / Activation (0 to +3)</label>
          <div class="bpt-axis-group" id="bpt-elev-group">
            ${elevLabels
              .map(
                ([num, lbl], idx) => `
              <button type="button" class="bpt-axis-btn ${elev === idx ? 'is-elev-active' : ''}" data-elev="${idx}">
                <strong>${num}</strong><span>${lbl}</span>
              </button>`
              )
              .join('')}
          </div>
        </div>
        <div>
          <label class="bpt-field-label">Depression / Dysphoria (0 to -3)</label>
          <div class="bpt-axis-group" id="bpt-dep-group">
            ${depLabels
              .map(
                ([num, lbl], idx) => `
              <button type="button" class="bpt-axis-btn ${dep === idx ? 'is-dep-active' : ''}" data-dep="${idx}">
                <strong>${num}</strong><span>${lbl}</span>
              </button>`
              )
              .join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>2. Sleep, Need for Sleep, Energy & Meds</span></div>
      <div class="plug-grid-3">
        <div>
          <label class="bpt-field-label" for="bpt-sleep-hrs">Total Sleep (hours)</label>
          <input type="number" step="0.5" min="0" max="24" id="bpt-sleep-hrs" class="plug-input" placeholder="e.g., 7.0" value="${existing.sleepHours ?? ''}" />
        </div>
        <div>
          <label class="bpt-field-label" for="bpt-sleep-need">Restedness / Need for Sleep</label>
          <select id="bpt-sleep-need" class="plug-select">
            <option value="normal" ${!existing.sleepNeed || existing.sleepNeed === 'normal' ? 'selected' : ''}>Normal sleep need</option>
            <option value="deprived" ${existing.sleepNeed === 'deprived' ? 'selected' : ''}>Short sleep — Tired / Deprived</option>
            <option value="decreased" ${existing.sleepNeed === 'decreased' ? 'selected' : ''}>Short sleep — Wired / Decreased need</option>
            <option value="hypersomnia" ${existing.sleepNeed === 'hypersomnia' ? 'selected' : ''}>Oversleeping / Heavy fatigue</option>
          </select>
        </div>
        <div>
          <label class="bpt-field-label" for="bpt-energy">Energy / Activation (1–5)</label>
          <select id="bpt-energy" class="plug-select">
            ${[1, 2, 3, 4, 5]
              .map(
                (v) =>
                  `<option value="${v}" ${(existing.energy || 3) === v ? 'selected' : ''}>${v} — ${
                    ['Very Low / Exhausted', 'Low', 'Balanced (3)', 'High / Driven', 'Wired / Agitated'][v - 1]
                  }</option>`
              )
              .join('')}
          </select>
        </div>
      </div>

      <div class="plug-grid-2" style="margin-top:10px;">
        <div>
          <label class="bpt-field-label" for="bpt-med-status">Medication Adherence</label>
          <select id="bpt-med-status" class="plug-select">
            <option value="taken" ${existing.medStatus === 'taken' ? 'selected' : ''}>Taken as prescribed</option>
            <option value="partial" ${existing.medStatus === 'partial' ? 'selected' : ''}>Partial / Late dose</option>
            <option value="missed" ${existing.medStatus === 'missed' ? 'selected' : ''}>Missed dose</option>
            <option value="na" ${!existing.medStatus || existing.medStatus === 'na' ? 'selected' : ''}>Not applicable / Unmedicated</option>
          </select>
        </div>
        <div>
          <label class="bpt-field-label" for="bpt-prn">PRN / Rescue Meds or Side Effects</label>
          <input type="text" id="bpt-prn" class="plug-input" placeholder="Optional PRN or side-effect note" value="${esc(existing.prn || '')}" />
        </div>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>3. Symptoms, Triggers & Personal Prodromes</span></div>
      <label class="bpt-field-label">Clinical Symptoms</label>
      <div class="bpt-chip-wrap" style="margin-bottom:10px;">
        ${SYMPTOM_OPTIONS.map(
          (s) =>
            `<button type="button" class="bpt-check-chip ${syms.has(s) ? 'is-on' : ''}" data-chip-group="symptoms" data-chip-val="${esc(s)}">${esc(s)}</button>`
        ).join('')}
      </div>
      <label class="bpt-field-label">Circadian & Biological Triggers</label>
      <div class="bpt-chip-wrap" style="margin-bottom:10px;">
        ${TRIGGER_OPTIONS.map(
          (t) =>
            `<button type="button" class="bpt-check-chip ${trigs.has(t) ? 'is-on' : ''}" data-chip-group="triggers" data-chip-val="${esc(t)}">${esc(t)}</button>`
        ).join('')}
      </div>
      ${
        personalProdromes.length
          ? `<label class="bpt-field-label">Personal Early-Warning Signs (Edit in Safety Plan tab)</label>
             <div class="bpt-chip-wrap">
               ${personalProdromes
                 .map(
                   (p) =>
                     `<button type="button" class="bpt-check-chip ${prodChecks.has(p) ? 'is-on' : ''}" data-chip-group="prodromes" data-chip-val="${esc(p)}">${esc(p)}</button>`
                 )
                 .join('')}
             </div>`
          : ''
      }
    </div>

    <div class="plug-card">
      <details class="bpt-collapsible">
        <summary><span>4. Optional IPSRT Social Rhythm Metric (SRM-5 Anchors)</span><span style="font-size:0.75rem;color:var(--plug-muted);">Expand ▾</span></summary>
        <div class="plug-grid-3" style="margin-top:10px;">
          <div><label class="bpt-field-label">Wake Time</label><input type="time" id="bpt-srm-wake" class="plug-input" value="${esc(srmVals.wake || '')}" /></div>
          <div><label class="bpt-field-label">First Human Contact</label><input type="time" id="bpt-srm-contact" class="plug-input" value="${esc(srmVals.contact || '')}" /></div>
          <div><label class="bpt-field-label">Work / Study Start</label><input type="time" id="bpt-srm-work" class="plug-input" value="${esc(srmVals.work || '')}" /></div>
          <div><label class="bpt-field-label">Dinner Time</label><input type="time" id="bpt-srm-dinner" class="plug-input" value="${esc(srmVals.dinner || '')}" /></div>
          <div><label class="bpt-field-label">Bedtime</label><input type="time" id="bpt-srm-bed" class="plug-input" value="${esc(srmVals.bed || '')}" /></div>
        </div>
      </details>
    </div>

    <div class="plug-card">
      <label class="bpt-field-label" for="bpt-daily-note">Brief Clinical Context / Trigger Note</label>
      <textarea id="bpt-daily-note" class="plug-textarea" placeholder="Optional context for appointments (e.g., exam stress, schedule change, prodrome insight)...">${esc(existing.note || '')}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;">
        ${
          data.logs[date]
            ? `<button type="button" id="bpt-delete-day" class="plug-btn plug-btn-danger plug-btn-sm">Delete ${esc(date)} Log</button>`
            : '<span></span>'
        }
        <button type="button" id="bpt-save-day" class="plug-btn plug-btn-primary">Save Daily Log</button>
      </div>
    </div>
  `;
}

function bindDailyLogTab(backdrop, data) {
  let elev = Number(data.logs[pluginState.selectedDate]?.elevation) || 0;
  let dep = Number(data.logs[pluginState.selectedDate]?.depression) || 0;

  backdrop.querySelector('#bpt-date-input').addEventListener('change', (e) => {
    if (e.target.value) {
      pluginState.selectedDate = e.target.value;
      renderBipolarTrackerModal();
    }
  });
  backdrop.querySelector('#bpt-prev-day').addEventListener('click', () => {
    pluginState.selectedDate = shiftISO(pluginState.selectedDate, -1);
    renderBipolarTrackerModal();
  });
  backdrop.querySelector('#bpt-next-day').addEventListener('click', () => {
    pluginState.selectedDate = shiftISO(pluginState.selectedDate, 1);
    renderBipolarTrackerModal();
  });

  backdrop.querySelectorAll('[data-elev]').forEach((btn) => {
    btn.addEventListener('click', () => {
      elev = Number(btn.getAttribute('data-elev'));
      backdrop.querySelectorAll('[data-elev]').forEach((b) => b.classList.remove('is-elev-active'));
      btn.classList.add('is-elev-active');
    });
  });

  backdrop.querySelectorAll('[data-dep]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dep = Number(btn.getAttribute('data-dep'));
      backdrop.querySelectorAll('[data-dep]').forEach((b) => b.classList.remove('is-dep-active'));
      btn.classList.add('is-dep-active');
    });
  });

  backdrop.querySelectorAll('.bpt-check-chip').forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('is-on'));
  });

  const collectChips = (group) =>
    Array.from(backdrop.querySelectorAll(`.bpt-check-chip.is-on[data-chip-group="${group}"]`)).map((c) =>
      c.getAttribute('data-chip-val')
    );

  backdrop.querySelector('#bpt-save-day').addEventListener('click', async () => {
    const sleepRaw = backdrop.querySelector('#bpt-sleep-hrs').value;
    const sleepHours = sleepRaw === '' ? null : Number(sleepRaw);
    const srm = {
      wake: backdrop.querySelector('#bpt-srm-wake').value || '',
      contact: backdrop.querySelector('#bpt-srm-contact').value || '',
      work: backdrop.querySelector('#bpt-srm-work').value || '',
      dinner: backdrop.querySelector('#bpt-srm-dinner').value || '',
      bed: backdrop.querySelector('#bpt-srm-bed').value || '',
    };

    data.logs[pluginState.selectedDate] = {
      elevation: elev,
      depression: dep,
      sleepHours: Number.isFinite(sleepHours) ? sleepHours : null,
      sleepNeed: backdrop.querySelector('#bpt-sleep-need').value,
      energy: Number(backdrop.querySelector('#bpt-energy').value) || 3,
      medStatus: backdrop.querySelector('#bpt-med-status').value,
      prn: backdrop.querySelector('#bpt-prn').value.trim(),
      symptoms: collectChips('symptoms'),
      triggers: collectChips('triggers'),
      prodromes: collectChips('prodromes'),
      srm,
      note: backdrop.querySelector('#bpt-daily-note').value.trim(),
      updatedAt: new Date().toISOString(),
    };

    await persistTrackerStore();
    showPluginToast(`Saved log for ${pluginState.selectedDate}`);
    renderBipolarTrackerModal();
  });

  const delBtn = backdrop.querySelector('#bpt-delete-day');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      delete data.logs[pluginState.selectedDate];
      await persistTrackerStore();
      showPluginToast(`Deleted log for ${pluginState.selectedDate}`);
      renderBipolarTrackerModal();
    });
  }
}

/* --- TAB 2: CHARTS, MILESTONES & PASSIVE SIGNALS --- */

function renderChartsTab(data, passive, srm) {
  const milestones = [...(data.milestones || [])].sort((a, b) => b.date.localeCompare(a.date));
  return `
    <div class="plug-card">
      <div class="plug-card-title">
        <span>Dual-Axis Mood, Sleep & Milestone Trajectory</span>
        <div style="display:flex;gap:6px;">
          <button type="button" class="plug-btn plug-btn-sm ${pluginState.chartRangeDays === 30 ? 'plug-btn-primary' : ''}" data-range="30">30 Days</button>
          <button type="button" class="plug-btn plug-btn-sm ${pluginState.chartRangeDays === 90 ? 'plug-btn-primary' : ''}" data-range="90">90 Days</button>
        </div>
      </div>
      ${renderDualAxisSVG(data, pluginState.chartRangeDays)}
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>Perpetual Year-over-Year Seasonal Overlay</span></div>
      <p class="plug-subtitle" style="margin:0 0 10px;">Compares net polarity (Elevation − Depression) across the same ±30-day calendar window from previous years to spot recurring seasonal vulnerability.</p>
      ${renderSeasonalOverlaySVG(data)}
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>Passive Local Diary Biomarkers (Last 14 Active Days)</span></div>
      <p class="plug-subtitle" style="margin:0 0 10px;">Computed strictly in browser RAM from your loaded diary text—zero manual input required.</p>
      <div class="plug-grid-3">
        <div class="plug-card" style="margin:0;">
          <span class="bpt-field-label">Avg Daily Word Count</span>
          <strong style="font-size:1.15rem;">${passive.avgWords.toLocaleString()}</strong>
        </div>
        <div class="plug-card" style="margin:0;">
          <span class="bpt-field-label">Late-Night Posts (12a–5a)</span>
          <strong style="font-size:1.15rem;${passive.lateNightCount >= 3 ? 'color:var(--plug-elev);' : ''}">${passive.lateNightCount}</strong>
        </div>
        <div class="plug-card" style="margin:0;">
          <span class="bpt-field-label">Multi-Entry Burst Days</span>
          <strong style="font-size:1.15rem;">${passive.multiEntryDays}</strong>
        </div>
      </div>
      <div class="plug-stat-strip" style="margin-top:10px;margin-bottom:0;">
        <span>Absolutist Word Rate: <strong>${passive.absRate}%</strong></span>
        <span>·</span>
        <span>SRM-5 Circadian Regularity: <strong>${srm.score !== null ? `${srm.score}/100 (±${srm.avgDevMin}m SD)` : 'Log 3+ SRM-5 days'}</strong></span>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>Medication & Care Timeline Milestones</span></div>
      <div class="plug-grid-3" style="margin-bottom:10px;">
        <input type="date" id="bpt-ms-date" class="plug-input" value="${esc(todayISO())}" />
        <input type="text" id="bpt-ms-label" class="plug-input" placeholder="e.g., Increased dose / New med" />
        <button type="button" id="bpt-ms-add" class="plug-btn plug-btn-primary">Add Milestone Pin</button>
      </div>
      ${
        milestones.length
          ? milestones
              .map(
                (m) => `
            <div class="pdx-row" style="margin-bottom:6px;padding:8px 12px;">
              <div class="pdx-row-top">
                <span><strong style="color:var(--plug-accent);">${esc(m.date)}</strong> · ${esc(m.label)}</span>
                <button type="button" class="plug-btn plug-btn-sm plug-btn-danger bpt-ms-del" data-id="${esc(m.id)}">Remove</button>
              </div>
            </div>`
              )
              .join('')
          : `<p class="plug-subtitle" style="margin:0;">No milestones yet. Pins appear as vertical gold markers on your trajectory chart.</p>`
      }
    </div>
  `;
}

function bindChartsTab(backdrop, data) {
  backdrop.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pluginState.chartRangeDays = Number(btn.getAttribute('data-range')) || 30;
      renderBipolarTrackerModal();
    });
  });

  backdrop.querySelector('#bpt-ms-add').addEventListener('click', async () => {
    const date = backdrop.querySelector('#bpt-ms-date').value || todayISO();
    const label = backdrop.querySelector('#bpt-ms-label').value.trim();
    if (!label) return showPluginToast('Enter a milestone label first.');
    data.milestones = data.milestones || [];
    data.milestones.push({ id: `ms_${Date.now()}`, date, label, note: '' });
    await persistTrackerStore();
    showPluginToast('Milestone pinned to trajectory chart');
    renderBipolarTrackerModal();
  });

  backdrop.querySelectorAll('.bpt-ms-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      data.milestones = (data.milestones || []).filter((m) => m.id !== id);
      await persistTrackerStore();
      renderBipolarTrackerModal();
    });
  });
}

/* --- TAB 3: VALIDATED WEEKLY SCREENERS (ASRM & PHQ-9) --- */

function renderScreenersTab(data) {
  const history = [...(data.screeners || [])].sort((a, b) => b.date.localeCompare(a.date));
  return `
    <div class="plug-card">
      <div class="plug-card-title">
        <span>Altman Self-Rating Mania Scale (ASRM · Past 7 Days)</span>
        <span class="bpt-badge bpt-badge-elev">Cutoff: ≥ 6 / 20</span>
      </div>
      ${ASRM_ITEMS.map(
        (item, qIdx) => `
        <div class="bpt-screener-q">
          <p>${esc(item.q)}</p>
          <div class="bpt-scale-opts">
            ${item.opts
              .map(
                (opt, val) =>
                  `<button type="button" class="bpt-scale-opt ${val === 0 ? 'is-picked' : ''}" data-asrm-q="${qIdx}" data-val="${val}">${esc(opt)}</button>`
              )
              .join('')}
          </div>
        </div>`
      ).join('')}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:10px;flex-wrap:wrap;">
        <span id="bpt-asrm-live" style="font-weight:700;font-size:0.88rem;">Current ASRM Score: 0 / 20</span>
        <button type="button" id="bpt-save-asrm" class="plug-btn plug-btn-primary">Save ASRM Score</button>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title">
        <span>PHQ-9 Depression Screener (Past 14 Days)</span>
        <span class="bpt-badge bpt-badge-dep">Moderate: ≥ 10 / 27</span>
      </div>
      ${PHQ9_ITEMS.map(
        (qText, qIdx) => `
        <div class="bpt-screener-q">
          <p>${esc(qText)}</p>
          <div class="bpt-scale-opts">
            ${PHQ9_SCALE.map(
              (opt, val) =>
                `<button type="button" class="bpt-scale-opt ${val === 0 ? 'is-picked' : ''}" data-phq-q="${qIdx}" data-val="${val}">${esc(opt)}</button>`
            ).join('')}
          </div>
        </div>`
      ).join('')}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:10px;flex-wrap:wrap;">
        <span id="bpt-phq-live" style="font-weight:700;font-size:0.88rem;">Current PHQ-9 Score: 0 / 27</span>
        <button type="button" id="bpt-save-phq" class="plug-btn plug-btn-primary">Save PHQ-9 Score</button>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>Saved Screener History</span></div>
      ${
        history.length
          ? history
              .map((s) => {
                const flagged = (s.type === 'ASRM' && s.score >= 6) || (s.type === 'PHQ9' && s.score >= 10);
                return `
              <div class="pdx-row" style="margin-bottom:8px;padding:9px 12px;">
                <div class="pdx-row-top">
                  <span>
                    <strong>${esc(s.date)}</strong> ·
                    <span class="bpt-badge ${s.type === 'ASRM' ? 'bpt-badge-elev' : 'bpt-badge-dep'}">${esc(s.type)}: ${s.score}/${s.type === 'ASRM' ? 20 : 27}</span>
                    ${flagged ? '<span class="bpt-badge bpt-badge-danger" style="margin-left:6px;">Above Clinical Cutoff</span>' : ''}
                  </span>
                  <button type="button" class="plug-btn plug-btn-sm plug-btn-danger bpt-scr-del" data-id="${esc(s.id)}">Delete</button>
                </div>
              </div>`;
              })
              .join('')
          : `<p class="plug-subtitle" style="margin:0;">No screeners saved yet.</p>`
      }
    </div>
  `;
}

function bindScreenersTab(backdrop, data) {
  const asrmVals = new Array(ASRM_ITEMS.length).fill(0);
  const phqVals = new Array(PHQ9_ITEMS.length).fill(0);

  backdrop.querySelectorAll('[data-asrm-q]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = Number(btn.getAttribute('data-asrm-q'));
      const v = Number(btn.getAttribute('data-val'));
      asrmVals[q] = v;
      backdrop.querySelectorAll(`[data-asrm-q="${q}"]`).forEach((b) => b.classList.remove('is-picked'));
      btn.classList.add('is-picked');
      const total = asrmVals.reduce((a, b) => a + b, 0);
      backdrop.querySelector('#bpt-asrm-live').textContent = `Current ASRM Score: ${total} / 20${total >= 6 ? ' (Elevated Cutoff Reached)' : ''}`;
    });
  });

  backdrop.querySelectorAll('[data-phq-q]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = Number(btn.getAttribute('data-phq-q'));
      const v = Number(btn.getAttribute('data-val'));
      phqVals[q] = v;
      backdrop.querySelectorAll(`[data-phq-q="${q}"]`).forEach((b) => b.classList.remove('is-picked'));
      btn.classList.add('is-picked');
      const total = phqVals.reduce((a, b) => a + b, 0);
      backdrop.querySelector('#bpt-phq-live').textContent = `Current PHQ-9 Score: ${total} / 27${total >= 10 ? ' (Moderate+ Cutoff)' : ''}`;
    });
  });

  backdrop.querySelector('#bpt-save-asrm').addEventListener('click', async () => {
    const score = asrmVals.reduce((a, b) => a + b, 0);
    data.screeners = data.screeners || [];
    data.screeners.push({ id: `scr_${Date.now()}`, date: todayISO(), type: 'ASRM', score, answers: [...asrmVals] });
    await persistTrackerStore();
    showPluginToast(`Saved ASRM score (${score}/20)`);
    renderBipolarTrackerModal();
  });

  backdrop.querySelector('#bpt-save-phq').addEventListener('click', async () => {
    const score = phqVals.reduce((a, b) => a + b, 0);
    data.screeners = data.screeners || [];
    data.screeners.push({ id: `scr_${Date.now()}`, date: todayISO(), type: 'PHQ9', score, answers: [...phqVals] });
    await persistTrackerStore();
    showPluginToast(`Saved PHQ-9 score (${score}/27)`);
    renderBipolarTrackerModal();
  });

  backdrop.querySelectorAll('.bpt-scr-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      data.screeners = (data.screeners || []).filter((s) => s.id !== id);
      await persistTrackerStore();
      renderBipolarTrackerModal();
    });
  });
}

/* --- TAB 4: STANLEY-BROWN SAFETY PLAN, PRODROME SIGNATURE & VAULT --- */

function renderSafetyAndVaultTab(data) {
  const sp = data.safetyPlan || {};
  const elevSigns = (data.prodromes?.elevation || []).join(', ');
  const depSigns = (data.prodromes?.depression || []).join(', ');

  return `
    <div class="plug-card">
      <div class="plug-card-title"><span>Encrypted Stanley-Brown 6-Step Safety Plan</span></div>
      <div class="plug-grid-2">
        <div>
          <label class="bpt-field-label">1. Personal Warning Signs (Thoughts, moods, behaviors)</label>
          <textarea id="bpt-sp-1" class="plug-textarea">${esc(sp.warningSigns || '')}</textarea>
        </div>
        <div>
          <label class="bpt-field-label">2. Internal Coping Strategies (Solo grounding steps)</label>
          <textarea id="bpt-sp-2" class="plug-textarea">${esc(sp.internalCoping || '')}</textarea>
        </div>
        <div>
          <label class="bpt-field-label">3. People & Social Settings That Provide Distraction</label>
          <textarea id="bpt-sp-3" class="plug-textarea">${esc(sp.socialDistractions || '')}</textarea>
        </div>
        <div>
          <label class="bpt-field-label">4. Trusted People I Can Ask for Help</label>
          <textarea id="bpt-sp-4" class="plug-textarea">${esc(sp.supportContacts || '')}</textarea>
        </div>
        <div>
          <label class="bpt-field-label">5. Clinicians, Doctors & Crisis Hotlines</label>
          <textarea id="bpt-sp-5" class="plug-textarea" placeholder="Psychiatrist, therapist, local crisis line...">${esc(sp.professionalsAndHotlines || '')}</textarea>
        </div>
        <div>
          <label class="bpt-field-label">6. Making the Environment Safe</label>
          <textarea id="bpt-sp-6" class="plug-textarea">${esc(sp.safeEnvironment || '')}</textarea>
        </div>
      </div>
      <div style="margin-top:10px;text-align:right;">
        <button type="button" id="bpt-save-safety" class="plug-btn plug-btn-primary">Save Safety Plan</button>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>Personal Relapse Signature (Comma-Separated)</span></div>
      <div class="plug-grid-2">
        <div>
          <label class="bpt-field-label">Elevation / Hypomania Prodromes</label>
          <input type="text" id="bpt-prod-elev" class="plug-input" value="${esc(elevSigns)}" />
        </div>
        <div>
          <label class="bpt-field-label">Depression Prodromes</label>
          <input type="text" id="bpt-prod-dep" class="plug-input" value="${esc(depSigns)}" />
        </div>
      </div>
      <div style="margin-top:10px;text-align:right;">
        <button type="button" id="bpt-save-prodromes" class="plug-btn">Update Early-Warning Chips</button>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>Tracker Encryption & Backup (AES-256-GCM)</span></div>
      <p class="plug-subtitle" style="margin:0 0 10px;">
        Status: <strong>${pluginState.passphrase ? 'Encrypted with passphrase' : 'Unencrypted locally (Set a passphrase below to encrypt before vault sync)'}</strong>
      </p>
      <div class="plug-grid-2">
        <input type="password" id="bpt-new-pass" class="plug-input" placeholder="Set or change tracker passphrase" autocomplete="new-password" />
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" id="bpt-set-pass" class="plug-btn plug-btn-primary">Encrypt & Sync</button>
          ${pluginState.passphrase ? `<button type="button" id="bpt-lock-now" class="plug-btn">Lock Now</button>` : ''}
          <button type="button" id="bpt-export-json" class="plug-btn">Export JSON</button>
        </div>
      </div>
    </div>
  `;
}

function bindSafetyAndVaultTab(backdrop, data) {
  backdrop.querySelector('#bpt-save-safety').addEventListener('click', async () => {
    data.safetyPlan = {
      warningSigns: backdrop.querySelector('#bpt-sp-1').value.trim(),
      internalCoping: backdrop.querySelector('#bpt-sp-2').value.trim(),
      socialDistractions: backdrop.querySelector('#bpt-sp-3').value.trim(),
      supportContacts: backdrop.querySelector('#bpt-sp-4').value.trim(),
      professionalsAndHotlines: backdrop.querySelector('#bpt-sp-5').value.trim(),
      safeEnvironment: backdrop.querySelector('#bpt-sp-6').value.trim(),
    };
    await persistTrackerStore();
    showPluginToast('Safety Plan saved');
  });

  backdrop.querySelector('#bpt-save-prodromes').addEventListener('click', async () => {
    const splitClean = (v) =>
      String(v || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    data.prodromes = {
      elevation: splitClean(backdrop.querySelector('#bpt-prod-elev').value),
      depression: splitClean(backdrop.querySelector('#bpt-prod-dep').value),
    };
    await persistTrackerStore();
    showPluginToast('Updated personal relapse signature chips');
  });

  backdrop.querySelector('#bpt-set-pass').addEventListener('click', async () => {
    const pw = backdrop.querySelector('#bpt-new-pass').value;
    if (!pw || pw.length < 4) return showPluginToast('Use a passphrase of at least 4 characters.');
    pluginState.passphrase = pw;
    await persistTrackerStore();
    showPluginToast('Tracker encrypted with AES-256-GCM');
    renderBipolarTrackerModal();
  });

  const lockBtn = backdrop.querySelector('#bpt-lock-now');
  if (lockBtn) {
    lockBtn.addEventListener('click', async () => {
      await persistTrackerStore();
      pluginState.passphrase = null;
      await loadTrackerStore();
      renderBipolarTrackerModal();
    });
  }

  backdrop.querySelector('#bpt-export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bipolar-tracker-backup-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    showPluginToast('Exported JSON backup');
  });
}

/* ==========================================================================
   10. HEADER TRIGGER INJECTION & BOOTSTRAP
   ========================================================================== */

function mountPluginTriggers() {
  if (document.getElementById('plug-trigger-dock')) return;

  const dock = document.createElement('div');
  dock.id = 'plug-trigger-dock';

  const indexBtn = document.createElement('button');
  indexBtn.type = 'button';
  indexBtn.className = 'plug-trigger-btn';
  indexBtn.textContent = 'Index';
  indexBtn.title = 'Open Simple Entry & Tag Index';
  indexBtn.addEventListener('click', openSimpleIndexModal);

  const moodBtn = document.createElement('button');
  moodBtn.type = 'button';
  moodBtn.className = 'plug-trigger-btn';
  moodBtn.textContent = 'Mood Tracker';
  moodBtn.title = 'Open Science-Based Bipolar & Circadian Tracker';
  moodBtn.addEventListener('click', () => openBipolarTrackerModal());

  dock.appendChild(indexBtn);
  dock.appendChild(moodBtn);

  // Attach cleanly into existing header action container if present; otherwise use floating dock
  const headerTarget =
    document.querySelector('.header-actions, .topbar-actions, .nav-actions, header .actions, header .right') ||
    document.querySelector('header');

  if (headerTarget) {
    dock.className = 'plug-dock-inline';
    headerTarget.appendChild(dock);
  } else {
    dock.className = 'plug-dock-floating';
    document.body.appendChild(dock);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePluginModals();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountPluginTriggers);
} else {
  mountPluginTriggers();
}
