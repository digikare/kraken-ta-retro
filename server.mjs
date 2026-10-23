// Serveur KRAKEN — Node 24+, aucune dépendance. Lancement : npm start
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const HTML = path.join(__dirname, 'public', 'index.html');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const memory = new Map(); // code -> état
const flux = new Map();   // code -> navigateurs connectés (SSE)

function diskPath(code){ return path.join(DATA, code.replace(/[^A-Z0-9]/g, '') + '.json'); }
function diskLoad(code){ try { return JSON.parse(fs.readFileSync(diskPath(code), 'utf8')); } catch { return null; } }
function diskSave(code, st){ try { fs.writeFileSync(diskPath(code), JSON.stringify(st)); } catch {} }

function unionById(A, B){
  const m = new Map();
  for (const x of A) { if (!m.has(x.id) || (x.upd || 0) > (m.get(x.id).upd || 0)) m.set(x.id, x); }
  for (const x of B) { if (!m.has(x.id) || (x.upd || 0) > (m.get(x.id).upd || 0)) m.set(x.id, x); }
  return [...m.values()];
}

/* Fusion côté serveur : identique à celle du client. Chaque personne reste
   autoritaire sur ses propres votes (votesAt le plus récent gagne). */
function mergeStates(a, b){
  if (!a) return b;
  if (!b) return a;
  const base = (a.rev >= b.rev) ? a : b;
  const pm = new Map();
  for (const p of [...(a.participants || []), ...(b.participants || [])]) pm.set(p.id, p);
  const pids = new Set([...Object.keys(a.votes || {}), ...Object.keys(b.votes || {})]);
  const votes = {}, votesAt = {};
  for (const pid of pids) {
    const ta = (a.votesAt && a.votesAt[pid]) || 0;
    const tb = (b.votesAt && b.votesAt[pid]) || 0;
    votes[pid] = (tb > ta) ? (b.votes[pid] || {}) : (a.votes[pid] || {});
    votesAt[pid] = Math.max(ta, tb);
  }
  const discussed = { ...(a.discussed || {}) };
  for (const k of Object.keys(b.discussed || {})) if (b.discussed[k]) discussed[k] = true;
  return {
    ...base,
    rev: Math.max(a.rev || 0, b.rev || 0),
    participants: [...pm.values()],
    notes: unionById(a.notes || [], b.notes || []),
    themes: unionById(a.themes || [], b.themes || []),
    actions: unionById(a.actions || [], b.actions || []),
    votes, votesAt, discussed,
    faci: base.faci || a.faci || b.faci || ''
  };
}

function broadcast(code, msg){
  const set = flux.get(code);
  if (!set) return;
  const payload = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const res of set) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

/* ================== IA — « Le Kraken suggère » (V2) ==================
   Zéro dépendance : fetch natif Node ≥ 18. Endpoint compatible OpenAI
   (Mistral Studio, Ollama, LM Studio…).

   CONFIGURATION — uniquement par variables d'environnement :
   IA_URL, IA_MODEL et IA_KEY. Ne jamais écrire de clé dans le code.
   Les valeurs par défaut de l'URL et du modèle ciblent Scaleway.
   Sans clé : /ia répond « non configuré », la fonctionnalité est
   masquée côté client — l'application reste utilisable sans IA.
   Anonymat : seuls {indice, zone, texte} sont transmis au modèle,
   jamais les auteurs ni les ids. L'IA ne mute jamais l'état : elle
   propose, les humains disposent (actions reducer existantes).

   Configuration locale (Node >= 24) :
     cp .env.example .env
     # Renseigner une NOUVELLE clé dans .env, puis :
     npm start
   Il est aussi possible de fournir les variables via l'environnement du
   processus et lancer : node server.mjs.
   Pour Ollama : IA_URL=http://127.0.0.1:11434/v1,
   IA_MODEL=qwen2.5:7b et IA_KEY=ollama (valeur locale factice). */
const IA_CFG = {
  url:   String(process.env.IA_URL ?? 'https://api.scaleway.ai/v1').trim().replace(/\/+$/, ''),
  model: String(process.env.IA_MODEL ?? 'qwen3-235b-a22b-instruct-2507').trim(),
  key:   String(process.env.IA_KEY ?? '').trim()
};
function iaPret(){ return !!(IA_CFG.url && IA_CFG.model && IA_CFG.key); }

const IA_ZONES = new Set(['objectif', 'vent', 'ancres', 'recifs']);
const IA_SYS = 'Tu es « le Kraken », assistant d\'analyse d\'une rétrospective d\'équipe ' +
  '(métaphore du voilier). Tu réponds UNIQUEMENT par un JSON valide, sans texte autour, ' +
  'sans balise markdown, sans explication.';

function iaSanitNotes(notes){
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, 80).map((n, i) => {
    n = n || {};
    return {
      i: Number.isInteger(n.i) ? n.i : i,
      zone: (typeof n.zone === 'string' && IA_ZONES.has(n.zone)) ? n.zone : '',
      text: String(n.text == null ? '' : n.text).slice(0, 300).trim()
    };
  }).filter(n => n.text.length > 0);
}

function iaPromptThemes(notes){
  const lignes = notes.map(n => n.i + ' [' + (n.zone || '?') + '] ' + n.text).join('\n');
  return [
    'Voici des notes anonymes d\'une rétrospective « voilier ».',
    'Zones : objectif (où veut-on aller), vent (ce qui nous aide), ancres (ce qui nous ralentit), récifs (les risques à anticiper).',
    'Regroupe les notes qui parlent du même sujet.',
    'Règles strictes :',
    '- 2 à 6 groupes au total ;',
    '- chaque groupe contient au moins 2 notes distinctes ;',
    '- chaque note apparaît dans AU PLUS un groupe ;',
    '- une note isolée qui ne se rattache à rien doit être ignorée ;',
    '- labels en français, concrets, sans emoji, 60 caractères maximum.',
    'Format de réponse EXACT (rien d\'autre) :',
    '{"tentacules":[{"label":"...","items":[0,2]}]}',
    'où items liste les indices des notes du groupe.',
    '',
    'Notes :',
    lignes
  ].join('\n');
}

async function iaUnAppel(userMsg, timeoutMs){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(IA_CFG.url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + IA_CFG.key },
      body: JSON.stringify({
        model: IA_CFG.model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: IA_SYS },
          { role: 'user', content: userMsg }
        ]
      }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      const err = new Error('llm-http-' + r.status);
      err.detail = detail;
      err.status = r.status;
      err.retryAfter = Number(r.headers.get('retry-after')) || 0;
      throw err;
    }
    const j = await r.json();
    return String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  } finally {
    clearTimeout(t);
  }
}

/* 429 (limite de débit) : un seul réessai après une courte attente. Le free
   tier Mistral n'autorise qu'~1 requête/seconde avec une priorité basse
   (capacité partagée, souvent congestionnée) — un second essai quelques
   secondes plus tard passe très souvent. Retry-After est honoré mais
   plafonné à 5 s : on ne laisse pas l'équipage attendre une minute entière
   devant le bouton. IA_RETRY_MS (env) règle l'attente par défaut (3000). */
function iaAppelleLlm(userMsg, timeoutMs = 20000){
  const base = Number(process.env.IA_RETRY_MS);
  const attente = Number.isFinite(base) && base >= 0 ? base : 3000;
  return iaUnAppel(userMsg, timeoutMs).catch(e => {
    if (!e || e.status !== 429) throw e;
    const ms = e.retryAfter > 0 ? Math.min(e.retryAfter * 1000, Math.max(attente, 5000)) : attente;
    console.error('[IA] 429 limite de débit — nouvel essai dans ' + Math.round(ms / 1000) + ' s…');
    return new Promise(r => setTimeout(r, ms)).then(() => iaUnAppel(userMsg, timeoutMs));
  });
}

/* Tolérant : fences markdown, clés tentacules|clusters|groupes, indices en
   strings, hors-plage, doublons, groupes de 1 → rejetés. Cap : 6 groupes. */
function iaParseTentacules(txt, nb){
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  let j;
  try { j = JSON.parse(m[0]); } catch { return []; }
  const arr = j.tentacules || j.clusters || j.groupes;
  if (!Array.isArray(arr)) return [];
  const vus = new Set();
  const out = [];
  for (const t of arr) {
    if (out.length >= 6) break;
    if (!t || typeof t !== 'object') continue;
    let label = String(t.label == null ? '' : t.label).trim();
    if (label.length > 60) label = label.slice(0, 59) + '…';
    if (!label) continue;
    const brut = Array.isArray(t.items) ? t.items : [];
    const uniq = [];
    for (const x of brut) {
      const idx = parseInt(x, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < nb && !vus.has(idx) && !uniq.includes(idx)) uniq.push(idx);
    }
    if (uniq.length < 2) continue;
    uniq.forEach(i => vus.add(i));
    out.push({ label, items: uniq });
  }
  return out;
}

function iaJson(res, code, obj){
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function iaHandler(req, res){
  if (req.method === 'GET') { iaJson(res, 200, { ok: true, ready: iaPret(), model: IA_CFG.model }); return; }
  if (req.method !== 'POST') { iaJson(res, 405, { ok: false, error: 'methode-inattendue' }); return; }
  if (!iaPret()) { iaJson(res, 503, { ok: false, error: 'ia-non-configuree' }); return; }
  let corps = '';
  let trop = false;
  req.on('data', c => { corps += c; if (corps.length > 65536) { trop = true; req.destroy(); } });
  req.on('end', async () => {
    if (trop) return;
    let d = {};
    try { d = JSON.parse(corps || '{}'); } catch { iaJson(res, 400, { ok: false, error: 'json-invalide' }); return; }
    if (d.task !== 'themes') { iaJson(res, 400, { ok: false, error: 'tache-inconnue' }); return; }
    const notes = iaSanitNotes(d.notes);
    if (notes.length < 2) { iaJson(res, 400, { ok: false, error: 'notes-insuffisantes' }); return; }
    const nb = notes.reduce((m, n) => Math.max(m, n.i + 1), 0);
    try {
      const txt = await iaAppelleLlm(iaPromptThemes(notes));
      iaJson(res, 200, { ok: true, tentacules: iaParseTentacules(txt, nb) });
    } catch (e) {
      const code = String(e.message || '');
      console.error('[IA] échec de l\'appel au modèle : ' + code + (e.detail ? ' — ' + String(e.detail).slice(0, 160) : ''));
      if (e.name === 'AbortError') iaJson(res, 502, { ok: false, error: 'delai-depasse' });
      else if (code.indexOf('llm-http-401') === 0 || code.indexOf('llm-http-403') === 0)
        iaJson(res, 502, { ok: false, error: 'clef-refusee', detail: (e.detail || '').slice(0, 160) });
      else if (code.indexOf('llm-http-429') === 0)
        iaJson(res, 502, { ok: false, error: 'quota-ia', detail: (e.detail || '').slice(0, 160) });
      else if (code.indexOf('llm-http-422') === 0)
        iaJson(res, 502, { ok: false, error: 'modele-refuse', detail: (e.detail || '').slice(0, 160) });
      else if (code.indexOf('llm-http-') === 0) iaJson(res, 502, { ok: false, error: 'service-indisponible', detail: (e.detail || '').slice(0, 160) });
      else iaJson(res, 502, { ok: false, error: 'erreur-ia', detail: String(e.message || e).slice(0, 160) });
    }
  });
}
const IA = iaHandler;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (p === '/' || p === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(HTML));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fichier public/index.html introuvable');
    }
    return;
  }

  if (p === '/flux') {
    const code = (u.searchParams.get('code') || '').toUpperCase();
    if (!code) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    if (!flux.has(code)) flux.set(code, new Set());
    flux.get(code).add(res);
    const st = memory.get(code) || diskLoad(code);
    if (st) res.write('data: ' + JSON.stringify({ src: '', state: st }) + '\n\n');
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); const s = flux.get(code); if (s) s.delete(res); });
    return;
  }

  if (p === '/envoi' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        if (m && m.code && m.state && m.state.code === m.code) {
          const prev = memory.get(m.code) || diskLoad(m.code);
          const merged = mergeStates(prev, m.state);
          memory.set(m.code, merged);
          diskSave(m.code, merged);
          broadcast(m.code, { src: m.src || '', state: merged });
          res.writeHead(200); res.end('ok');
        } else { res.writeHead(400); res.end('bad'); }
      } catch { res.writeHead(400); res.end('bad'); }
    });
    return;
  }

  if (p.startsWith('/session/') && req.method === 'DELETE') {
    const code = p.slice('/session/'.length).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'code-invalide' })); return; }
    const existe = memory.has(code) || !!diskLoad(code);
    if (!existe) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'session-inconnue' })); return; }
    memory.delete(code);
    try { fs.unlinkSync(diskPath(code)); } catch {}
    /* Éjection : prévenir les équipages connectés puis fermer le flux SSE.
       Le code de session EST le sésame (confiance physique, esprit V1) :
       quiconque a le code peut lire l'état — il peut donc la supprimer,
       avec confirmation humaine côté client avant l'appel. */
    broadcast(code, { src: '', supprimee: true, codeSuppr: code });
    const set = flux.get(code);
    if (set) { for (const r of set) { try { r.end(); } catch { set.delete(r); } } }
    flux.delete(code);
    console.log('[SESSION] ' + code + ' supprimée (mémoire + disque)');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, code }));
    return;
  }

  if (p.startsWith('/session/') && req.method === 'GET') {
    const code = p.slice('/session/'.length).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const st = memory.get(code) || diskLoad(code);
    if (st) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(st)); }
    else { res.writeHead(404); res.end('{}'); }
    return;
  }

  /* Import de session : le client envoie l'état JSON d'un fichier exporté.
     Refus si le code est déjà pris (prévisible), stockage mémoire + disque.
     Le client se joint ensuite par le flux normal (/flux renvoie l'état). */
  if (p === '/import' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const st = JSON.parse(body);
        const formeOk = st && typeof st.code === 'string'
          && Array.isArray(st.notes) && st.notes.length > 0
          && Array.isArray(st.participants) && st.participants.length > 0;
        if (!formeOk) { iaJson(res, 400, { ok: false, error: 'fichier-invalide' }); return; }
        const code = st.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
        if (!code) { iaJson(res, 400, { ok: false, error: 'fichier-invalide' }); return; }
        if (memory.get(code) || diskLoad(code)) { iaJson(res, 409, { ok: false, error: 'code-deja-pris', code }); return; }
        st.code = code;
        memory.set(code, st);
        diskSave(code, st);
        iaJson(res, 200, { ok: true, code });
      } catch { iaJson(res, 400, { ok: false, error: 'fichier-invalide' }); }
    });
    return;
  }

  if (p === '/ia') { IA(req, res); return; }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log('KRAKEN — serveur démarré (port ' + PORT + ')');
  if (iaPret()) console.log('  IA « Le Kraken suggère » : activée (' + IA_CFG.model + ')');
  else console.log('  IA : non configurée (IA_URL, IA_MODEL, IA_KEY) — fonctionnalité masquée');
  console.log('  Sur ce poste :        http://localhost:' + PORT);
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('  Sur le réseau Wi-Fi : http://' + net.address + ':' + PORT);
      }
    }
  }
});