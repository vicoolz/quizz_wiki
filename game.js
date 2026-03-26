'use strict';

/* ====================================================================
   CONFIG
   ==================================================================== */
const WP_API           = 'https://fr.wikipedia.org/w/api.php';
const WD_API           = 'https://www.wikidata.org/w/api.php';
const ARTICLES_PER_DAY = 10;
const BUFFER_SIZE       = ARTICLES_PER_DAY * 2; // buffer pour garantir 10 articles jouables
const MIN_HINTS        = 5;   // seuil minimum (catégories + Wikidata + description)

// Propriétés Wikidata à récupérer, par ordre de pertinence
const WIKIDATA_PROPS = [
    'P31',  // instance of (nature de l'élément)
    'P279', // subclass of (sous-classe, concepts)
    'P106', // occupation (métier)
    'P101', // field of work (domaine)
    'P136', // genre (œuvres culturelles)
    'P17',  // country (pays)
    'P27',  // citizenship (nationalité)
    'P19',  // place of birth (lieu de naissance)
    'P131', // located in (localisation)
    'P50',  // author (auteur)
    'P57',  // director (réalisateur)
    'P84',  // architect (architecte)
    'P495', // country of origin
    'P361', // part of
    'P710', // participant (evénements)
    'P166', // award received (récompenses)
    'P26',  // spouse (conjoint)
    'P569', // date of birth → année
    'P570', // date of death → année
    'P571', // inception → année
    'P577', // publication date → année
    'P580', // start time → année
    'P582', // end time → année
];
// Propriétés dont la valeur est une date → on extrait l'année uniquement
const WIKIDATA_DATE_PROPS = new Set(['P569','P570','P571','P577','P580','P582']);
// Limite du nombre de valeurs affichées par propriété
const WIKIDATA_PROP_LIMIT  = { P710: 4, P166: 3, P279: 2 };
// Labels Wikidata trop génériques pour être utiles comme indices
const WD_SKIP_LABELS = new Set([
    'entité','élément','chose','objet','concept abstrait','taxon',
    'groupe','groupe paraphyélétique','clade',
    'page de désambiguësation wikimedia',
    'article wikimedia de liste de contrôle',
    'wikimedia list article',
]);

/* ====================================================================
   GÉNÉRATEUR PSEUDO-ALÉATOIRE DÉTERMINISTE (seed = date)
   ==================================================================== */
function mkRng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dateSeed(dateStr) {
    let h = 5381;
    for (const c of dateStr + 'wq2') h = ((h << 5) + h) ^ c.charCodeAt(0);
    return h >>> 0;
}

/* ====================================================================
   NORMALISATION DES RÉPONSES
   Les parenthèses sont supprimées : "Baguette (pain)" → "baguette"
   ==================================================================== */
function normalize(s) {
    return s.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s*\(.*?\)\s*/g, ' ')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ').trim();
}

/* Distance de Levenshtein (pour la correspondance approximative) */
function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
}

function isCorrect(input, title) {
    const g = normalize(input);
    const t = normalize(title);
    if (!g) return false;
    if (g === t) return true;
    // Tolérance : 1 erreur si titre ≤ 6 lettres, 2 si ≤ 12, sinon 3
    const maxDist = t.length <= 6 ? 1 : t.length <= 12 ? 2 : 3;
    return levenshtein(g, t) <= maxDist;
}

/* ====================================================================
   POOL D'ARTICLES — plusieurs catégories en parallèle (~8 000–10 000 articles)
   ==================================================================== */

/**
 * Sources utilisées (toutes sur fr.wikipedia.org) :
 *   • Article de qualité  — les mieux rédigés (~2 500)
 *   • Bon article          — très bons articles (~5 500)
 * Combinées et dédupliquées → ~8 000 articles notables garantis.
 */
const POOL_SOURCES = [
    'Catégorie:Article de qualité',
    'Catégorie:Bon article',
];

/**
 * Récupère TOUS les membres d'une catégorie (pagination automatique).
 */
async function fetchCategoryAll(cmtitle) {
    const titles = [];
    let cmcontinue = null;
    do {
        const params = new URLSearchParams({
            action      : 'query',
            list        : 'categorymembers',
            cmtitle,
            cmlimit     : '500',
            cmtype      : 'page',
            cmnamespace : '0',
            format      : 'json',
            origin      : '*',
        });
        if (cmcontinue) params.set('cmcontinue', cmcontinue);
        const r = await fetch(`${WP_API}?${params}`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        (d?.query?.categorymembers || []).forEach(m => titles.push(m.title));
        cmcontinue = d?.continue?.cmcontinue ?? null;
    } while (cmcontinue);
    return titles;
}

async function fetchPool() {
    const key = `wq_pool_${todayStr()}`;
    try {
        const cached = localStorage.getItem(key);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed?.length > 100) return parsed;
        }
    } catch {}

    // Chargement progressif : on affiche un message avec le count en direct
    const setStatus = msg => {
        const el = document.getElementById('categories-container');
        if (el) el.innerHTML = `<p class="loading-msg">${msg}</p>`;
    };

    setStatus('⏳ Chargement du pool d\'articles depuis Wikipédia…');

    // Fetch toutes les sources en parallèle
    const results = await Promise.allSettled(
        POOL_SOURCES.map(cat => fetchCategoryAll(cat))
    );

    const seen   = new Set();
    const titles = [];
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            r.value.forEach(t => {
                if (!seen.has(t)) { seen.add(t); titles.push(t); }
            });
        } else {
            console.warn(`Source ${POOL_SOURCES[i]} échouée :`, r.reason);
        }
    });

    if (!titles.length) throw new Error('Pool vide — toutes les sources ont échoué');

    setStatus(`✅ ${titles.length} articles chargés. Tirage au sort…`);

    try { localStorage.setItem(key, JSON.stringify(titles)); } catch {
        // localStorage peut être plein, pas bloquant
    }
    return titles;
}

function pickDaily(pool, dateStr) {
    const rng  = mkRng(dateSeed(dateStr));
    const copy = [...pool];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, BUFFER_SIZE);
}

/* ====================================================================
   CATÉGORIES : récupération et filtrage
   ==================================================================== */
// Catégories de maintenance / méta à exclure
// Catégories visibles mais inutiles au jeu (le gros du ménage est fait par clshow=!hidden)
const CAT_EXCLUSIONS = [
    /article de qualité/i,
    /bon article/i,
    /label/i,
    /homonymie/i,
    /^portail\s*:/i,
    /^projet\s*:/i,
    /^éponyme/i,
    /^toponyme/i,
    /^anthroponyme/i,
    /^patronyme/i,
];

function filterCats(cats, title) {
    const nt    = normalize(title);
    const words = nt.split(' ').filter(w => w.length >= 4);
    return cats.filter(c => {
        if (CAT_EXCLUSIONS.some(re => re.test(c))) return false;
        const nc = normalize(c);
        // Exclure si TOUS les mots significatifs du titre apparaissent dans la catégorie
        if (words.length > 0 && words.every(w => nc.includes(w))) return false;
        return true;
    });
}

/**
 * Extrait l'année d'une valeur de date Wikidata.
 * "+1867-11-07T00:00:00Z" → "1867"
 * "-0400-00-00T00:00:00Z" → "400 av. J.-C."
 */
function wdTimeToYear(timeStr) {
    const m = timeStr.match(/^([+-])0*(\d{1,4})/);
    if (!m) return null;
    const year = parseInt(m[2], 10);
    if (year === 0) return null;
    return m[1] === '-' ? `${year} av. J.-C.` : String(year);
}

/**
 * Récupère les hints Wikidata pour un titre Wikipedia FR.
 * Gère les valeurs entité (label FR) et date (année).
 * Non bloquant : retourne [] en cas d'échec.
 */
async function fetchWikidataHints(title) {
    try {
        // Appel 1 : titre Wikipedia → entité Wikidata + claims + description
        const p1 = new URLSearchParams({
            action: 'wbgetentities', sites: 'frwiki', titles: title,
            props: 'claims|descriptions', languages: 'fr', format: 'json', origin: '*',
        });
        const r1 = await fetch(`${WD_API}?${p1}`, { signal: AbortSignal.timeout(8000) });
        if (!r1.ok) return [];
        const d1 = await r1.json();
        const entity = Object.values(d1?.entities || {})[0];
        if (!entity || entity.missing !== undefined) return { hints: [], description: '' };

        const description = entity.descriptions?.fr?.value || '';
        const qids  = new Set();
        const years = new Set();

        for (const prop of WIKIDATA_PROPS) {
            const claims = entity.claims?.[prop] || [];
            const limit  = WIKIDATA_PROP_LIMIT[prop] ?? Infinity;
            let count = 0;
            for (const claim of claims) {
                if (count >= limit) break;
                const dv = claim?.mainsnak?.datavalue;
                if (!dv) continue;
                if (WIKIDATA_DATE_PROPS.has(prop) && dv.type === 'time') {
                    const yr = wdTimeToYear(dv.value.time);
                    if (yr) { years.add(yr); count++; }
                } else if (dv.type === 'wikibase-entityid' && dv.value?.id) {
                    qids.add(dv.value.id); count++;
                }
            }
        }

        const hints = [...years];  // années en premier

        if (qids.size > 0) {
            // Appel 2 : résoudre les Q-IDs en labels français (max 50)
            const p2 = new URLSearchParams({
                action: 'wbgetentities', ids: [...qids].slice(0, 50).join('|'),
                props: 'labels', languages: 'fr', format: 'json', origin: '*',
            });
            const r2 = await fetch(`${WD_API}?${p2}`, { signal: AbortSignal.timeout(8000) });
            if (r2.ok) {
                const d2   = await r2.json();
                const seen = new Set(hints.map(h => h.toLowerCase()));
                for (const ent of Object.values(d2?.entities || {})) {
                    const lbl = ent?.labels?.fr?.value;
                    if (lbl && !WD_SKIP_LABELS.has(lbl.toLowerCase()) && !seen.has(lbl.toLowerCase())) {
                        seen.add(lbl.toLowerCase());
                        hints.push(lbl);
                    }
                }
            }
        }

        return { hints, description };
    } catch {
        return { hints: [], description: '' };
    }
}

/**
 * Filtre les hints Wikidata : exclure ceux qui contiennent tous les mots du titre.
 */
function filterHints(hints, title) {
    const nt    = normalize(title);
    const words = nt.split(' ').filter(w => w.length >= 4);
    return hints.filter(h => {
        const nh = normalize(h);
        if (words.length > 0 && words.every(w => nh.includes(w))) return false;
        return true;
    });
}

/**
 * Filtre la description Wikidata : masque si elle contient tous les mots significatifs du titre.
 */
function filterDescription(desc, title) {
    if (!desc) return '';
    const nt    = normalize(title);
    const words = nt.split(' ').filter(w => w.length >= 4);
    const nd    = normalize(desc);
    if (words.length > 0 && words.every(w => nd.includes(w))) return '';
    return desc;
}

/**
 * Récupère catégories Wikipedia (clshow=!hidden) + hints Wikidata en parallèle.
 */
async function fetchArticleData(title) {
    const [cats, wd] = await Promise.all([
        fetchCategoriesWP(title),
        fetchWikidataHints(title),
    ]);
    return {
        cats,
        hints      : filterHints(wd.hints, title),
        description: filterDescription(wd.description, title),
    };
}

/**
 * Récupère les catégories Wikipedia (avec pagination et clshow=!hidden).
 */
async function fetchCategoriesWP(title) {
    const raw = [];
    let clcontinue = null;
    do {
        const params = new URLSearchParams({
            action   : 'query',
            titles   : title,
            prop     : 'categories',
            cllimit  : '500',
            clshow   : '!hidden',
            format   : 'json',
            origin   : '*',
            redirects: '1',
        });
        if (clcontinue) params.set('clcontinue', clcontinue);
        const r = await fetch(`${WP_API}?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d    = await r.json();
        const page = Object.values(d?.query?.pages || {})[0];
        if (!page || 'missing' in page) break;
        (page.categories || []).forEach(c =>
            raw.push(c.title.replace(/^Catégorie\s*:\s*/i, '').trim())
        );
        clcontinue = d?.continue?.clcontinue ?? null;
    } while (clcontinue);

    return filterCats(raw, title);
}

/* ====================================================================
   ÉTAT DU JEU
   ==================================================================== */
let G = {
    today      : '',
    playDate   : '',
    articles   : [],
    idx        : 0,
    cats       : [],
    hints      : [],
    description: '',
    score      : 0,
    results    : [],
    attempts   : 0,
    phase      : 'idle',
};

/* ====================================================================
   PERSISTANCE
   ==================================================================== */
const gKey     = d  => `wq_g2_${d}`;
const statsKey = () => 'wq_s2';

function saveGame() {
    localStorage.setItem(gKey(G.playDate), JSON.stringify({
        score: G.score, results: G.results, done: G.phase === 'done',
        articles: G.articles, idx: G.idx,
    }));
}
function loadGame(date) {
    try { return JSON.parse(localStorage.getItem(gKey(date))); } catch { return null; }
}
function loadStats() {
    try {
        return JSON.parse(localStorage.getItem(statsKey())) ||
            { played:0, total:0, best:0, streak:0, lastDate:'', history:[], dist:{} };
    } catch { return { played:0, total:0, best:0, streak:0, lastDate:'', history:[], dist:{} }; }
}
function saveStats(score) {
    const s = loadStats();
    s.played++; s.total += score;
    if (score > s.best) s.best = score;
    const yest = new Date(); yest.setDate(yest.getDate()-1);
    const ys = `${yest.getFullYear()}-${String(yest.getMonth()+1).padStart(2,'0')}-${String(yest.getDate()).padStart(2,'0')}`;
    if (s.lastDate === ys) s.streak++; else if (s.lastDate !== G.today) s.streak = 1;
    s.lastDate = G.today;
    s.history.unshift({ date: G.playDate, score });
    if (s.history.length > 30) s.history.pop();
    s.dist[score] = (s.dist[score]||0) + 1;
    localStorage.setItem(statsKey(), JSON.stringify(s));
}

/* ====================================================================
   NAVIGATION
   ==================================================================== */
function go(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${id}`).classList.add('active');
}
const $ = id => document.getElementById(id);

function setControls(disabled) {
    ['btn-guess','btn-skip'].forEach(id => $(id).disabled = disabled);
    $('guess-input').disabled = disabled;
}

function updateProgress() {
    const played = G.results.length;
    $('article-num').textContent   = Math.min(played + 1, ARTICLES_PER_DAY);
    $('current-score').textContent = G.score;
    $('progress-fill').style.width = `${(played / ARTICLES_PER_DAY) * 100}%`;
}

function renderCats() {
    const box = $('categories-container');
    box.innerHTML = '';

    // Description courte Wikidata (1 phrase, en italique)
    if (G.description) {
        const p = document.createElement('p');
        p.className   = 'wd-description';
        p.textContent = G.description;
        box.appendChild(p);
    }

    G.cats.forEach(cat => {
        const pill = document.createElement('span');
        pill.className   = 'category-pill';
        pill.textContent = cat;
        box.appendChild(pill);
    });
    G.hints.forEach(hint => {
        const pill = document.createElement('span');
        pill.className   = 'category-pill wikidata-pill';
        pill.textContent = hint;
        box.appendChild(pill);
    });
}

/* ====================================================================
   DÉMARRAGE D'UNE PARTIE
   ==================================================================== */
async function beginGame(playDate) {
    G.today    = todayStr();
    G.playDate = playDate;
    G.score       = 0;
    G.results     = [];
    G.cats        = [];
    G.hints       = [];
    G.description = '';
    G.attempts    = 0;
    G.idx      = 0;
    G.phase    = 'loading-pool';

    go('game');
    $('article-total').textContent = ARTICLES_PER_DAY;
    updateProgress();
    $('categories-container').innerHTML = '<p class="loading-msg">⏳ Chargement des articles depuis Wikipédia…</p>';
    setControls(true);
    $('guess-section').classList.remove('hidden');
    $('result-section').classList.add('hidden');

    const saved = loadGame(playDate);

    try {
        if (saved?.articles?.length >= ARTICLES_PER_DAY) {
            G.articles = saved.articles;
        } else {
            const pool = await fetchPool();
            G.articles = pickDaily(pool, playDate);
        }
    } catch (e) {
        $('categories-container').innerHTML =
            `<p class="loading-msg error-msg">❌ Impossible de charger les articles (${e.message}).<br>Vérifiez votre connexion et rechargez la page.</p>`;
        return;
    }

    if (saved?.done) {
        G.score   = saved.score;
        G.results = saved.results || [];
        showResults();
        return;
    }
    if (saved?.results?.length) {
        // saved.idx est l'index du dernier article joué ; on reprend au suivant
        G.idx     = saved.idx !== undefined ? saved.idx + 1 : saved.results.length;
        G.score   = saved.score;
        G.results = saved.results;
    }

    await loadArticle();
}

/* ====================================================================
   CHARGEMENT DES CATÉGORIES D'UN ARTICLE
   ==================================================================== */
async function loadArticle() {
    // Boucle pour l'auto-skip (évite la récursion)
    while (true) {
        // Fini si on a joué 10 articles ou épuisé le buffer
        if (G.results.length >= ARTICLES_PER_DAY) { endGame(); return; }
        if (G.idx >= G.articles.length) { endGame(); return; }

        G.phase    = 'loading-cats';
        G.cats        = [];
        G.hints       = [];
        G.description = '';
        G.attempts = 0;

        const title = G.articles[G.idx];
        updateProgress();
        $('categories-container').innerHTML = '<p class="loading-msg">⏳ Chargement depuis Wikipédia…</p>';
        $('guess-section').classList.remove('hidden');
        $('result-section').classList.add('hidden');
        $('guess-input').value = '';
        setControls(true);

        try {
            const data = await fetchArticleData(title);
            G.cats        = data.cats;
            G.hints       = data.hints;
            G.description = data.description;
        } catch {
            $('categories-container').innerHTML =
                '<p class="loading-msg error-msg">❌ Erreur réseau. Vous pouvez passer cet article.</p>';
            G.cats        = [];
            G.hints       = [];
            G.description = '';
            $('btn-skip').disabled = false;
            G.phase = 'guessing';
            return;
        }

        if (G.cats.length + G.hints.length + (G.description ? 1 : 0) < MIN_HINTS) {
            // Pas assez d'indices : passer silencieusement au suivant
            G.idx++;
            continue;
        }

        break;
    }

    G.phase = 'guessing';
    renderCats();
    setControls(false);
    $('guess-input').focus();
}

/* ====================================================================
   ACTIONS
   ==================================================================== */
function submitGuess() {
    if (G.phase !== 'guessing') return;
    const val = $('guess-input').value.trim();
    if (!val) return;
    G.attempts++;
    if (isCorrect(val, G.articles[G.idx])) {
        endArticle(true);
    } else {
        // Une seule tentative : mauvaise réponse = échec immédiat
        endArticle(false);
    }
}

function skipArticle() {
    if (G.phase !== 'guessing' && G.phase !== 'loading-cats') return;
    endArticle(false);
}

/* ====================================================================
   FIN D'UN ARTICLE
   ==================================================================== */
function endArticle(ok) {
    G.phase = 'result';
    G.score += ok ? 1 : 0;
    const title = G.articles[G.idx];
    G.results.push({ title, ok, attempts: G.attempts });
    saveGame();

    $('guess-section').classList.add('hidden');
    $('result-section').classList.remove('hidden');

    const msgEl = $('result-message');
    msgEl.className = `result-message ${ok ? 'correct' : 'wrong'}`;
    msgEl.textContent = ok
        ? (G.attempts <= 1 ? '🏆 Du premier coup !' : '✅ Bien trouvé !')
        : '❌ Raté…';

    $('result-answer').textContent      = title;
    $('wiki-link').href                 = `https://fr.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    $('current-score').textContent      = G.score;
    $('btn-next').textContent = G.results.length >= ARTICLES_PER_DAY - 1 ? 'Voir les résultats' : 'Article suivant →';
}

async function goNext() {
    if (G.results.length >= ARTICLES_PER_DAY) { endGame(); return; }
    G.idx++;
    await loadArticle();
}

/* ====================================================================
   FIN DE PARTIE
   ==================================================================== */
function endGame() {
    G.phase = 'done';
    saveGame();
    if (G.playDate === G.today) saveStats(G.score);
    showResults();
}

/* ====================================================================
   ÉCRAN RÉSULTATS
   ==================================================================== */
function showResults() {
    $('final-score-value').textContent = G.score;
    $('final-score-max').textContent   = ARTICLES_PER_DAY;

    const bd = $('results-breakdown');
    bd.innerHTML = '';
    G.results.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'result-row';

        const numDiv  = document.createElement('div');
        numDiv.className   = 'result-num';
        numDiv.textContent = `#${i + 1}`;

        const titleDiv = document.createElement('div');
        titleDiv.className   = 'result-title';
        titleDiv.textContent = r.title;

        const ptsDiv = document.createElement('div');
        ptsDiv.className   = `result-pts ${r.ok ? 'pts-ok' : 'pts-fail'}`;
        ptsDiv.textContent = r.ok ? '✓' : '✗';

        row.appendChild(numDiv);
        row.appendChild(titleDiv);
        row.appendChild(ptsDiv);
        bd.appendChild(row);
    });

    go('results');
}

/* ====================================================================
   PARTAGE
   ==================================================================== */
function buildShareText() {
    let t = `🐟 Wiki Quizz — ${G.playDate}\n${G.score}/${ARTICLES_PER_DAY}\n\n`;
    G.results.forEach(r => { t += (r.ok ? '🟢' : '🔴') + '\n'; });
    return t;
}
function doShare() {
    const text = buildShareText();
    navigator.clipboard?.writeText(text).then(() => {
        const toast = $('share-toast');
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 2500);
    }).catch(() => alert(text));
}

/* ====================================================================
   STATISTIQUES
   ==================================================================== */
function renderStats() {
    const s = loadStats();
    $('stat-played').textContent = s.played;
    $('stat-avg').textContent    = s.played ? (s.total / s.played).toFixed(1) : 0;
    $('stat-best').textContent   = s.best;
    $('stat-streak').textContent = s.streak;

    const dist = $('score-distribution');
    dist.innerHTML = '';
    const entries = Object.entries(s.dist).map(([k,v]) => [+k,v]).sort((a,b) => a[0]-b[0]);
    if (!entries.length) {
        dist.innerHTML = '<p style="color:var(--text-muted);padding:8px">Aucune partie jouée.</p>';
    } else {
        const maxC = Math.max(...entries.map(e => e[1]));
        entries.forEach(([sc, count]) => {
            const row = document.createElement('div');
            row.className = 'dist-row';
            row.innerHTML =
                `<div class="dist-label">${sc}/${ARTICLES_PER_DAY}</div>
                 <div class="dist-bar-container">
                   <div class="dist-bar" style="width:${Math.max((count/maxC)*100,4)}%">${count}</div>
                 </div>`;
            dist.appendChild(row);
        });
    }

    const hist = $('stats-history');
    hist.innerHTML = '';
    if (!s.history.length) {
        hist.innerHTML = '<p style="padding:12px;color:var(--text-muted)">Aucun historique.</p>';
    } else {
        s.history.forEach(h => {
            const row = document.createElement('div');
            row.className = 'history-row';
            row.innerHTML =
                `<div class="history-date">${h.date}</div>
                 <div class="history-score">${h.score}/${ARTICLES_PER_DAY}</div>`;
            hist.appendChild(row);
        });
    }
    go('stats');
}

/* ====================================================================
   ARCHIVE (30 derniers jours)
   ==================================================================== */
function renderArchive() {
    const list  = $('archive-list');
    list.innerHTML = '';
    const today = new Date();
    for (let i = 1; i <= 30; i++) {
        const d  = new Date(today);
        d.setDate(today.getDate() - i);
        const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const saved = loadGame(ds);
        const row   = document.createElement('div');
        row.className = 'archive-row';
        if (saved?.done) {
            row.innerHTML =
                `<div class="archive-date">${ds}</div>
                 <div class="archive-score">${saved.score}/${ARTICLES_PER_DAY}</div>
                 <span class="archive-badge completed">Terminé</span>`;
        } else {
            row.innerHTML =
                `<div class="archive-date">${ds}</div>
                 <span class="archive-badge new">Jouer</span>`;
        }
        row.addEventListener('click', () => beginGame(ds));
        list.appendChild(row);
    }
    go('archive');
}

/* ====================================================================
   INITIALISATION
   ==================================================================== */
function init() {
    $('btn-play').addEventListener('click', () => beginGame(todayStr()));
    $('btn-how-to-play').addEventListener('click', () => go('howto'));
    $('btn-stats').addEventListener('click', renderStats);
    $('btn-archive').addEventListener('click', renderArchive);

    document.querySelectorAll('.btn-back').forEach(btn =>
        btn.addEventListener('click', () => go(btn.dataset.target || 'home'))
    );

    $('btn-guess').addEventListener('click', submitGuess);
    $('guess-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitGuess(); });
    $('btn-skip').addEventListener('click', skipArticle);
    $('btn-next').addEventListener('click', goNext);
    $('btn-share').addEventListener('click', doShare);
    $('btn-results-stats').addEventListener('click', renderStats);
    $('btn-replay').addEventListener('click', () => {
        const today = todayStr();
        // Effacer partie du jour + pool pour forcer un nouveau tirage avec le buffer de 20
        localStorage.removeItem(gKey(today));
        localStorage.removeItem(`wq_pool_${today}`);
        beginGame(today);
    });

    const saved = loadGame(todayStr());
    if (saved?.done) $('btn-play').textContent = 'Voir les résultats du jour →';

    go('home');
}

document.addEventListener('DOMContentLoaded', init);

// Utilitaire de développement : appeler resetAll() dans la console pour tout réinitialiser
window.resetAll = function() {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('wq_'));
    keys.forEach(k => localStorage.removeItem(k));
    console.log(`${keys.length} clés supprimées :`, keys);
    location.reload();
};
window.resetToday = function() {
    const today = todayStr();
    localStorage.removeItem(gKey(today));
    localStorage.removeItem(`wq_pool_${today}`);
    console.log('Partie et pool du jour effacés.');
    location.reload();
};
