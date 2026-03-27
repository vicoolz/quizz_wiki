#!/usr/bin/env node
/**
 * Script de construction du pool d'articles pour QuizzWiki.
 * Exécution : node build-articles.js
 *
 * Génère articles.js contenant ~25 000 articles Wikipedia FR
 * pré-filtrés par notoriété (sitelinks Wikidata) et sans année dans le titre.
 *
 * Prérequis : Node.js 18+ (fetch natif)
 */

'use strict';

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const OUT_FILE        = 'articles.js';
const MIN_SITELINKS   = 50;   // présent dans au moins 50 Wikipédias → sujet universellement connu
const TARGET          = 25000; // nombre d'articles voulu
const PAGE_SIZE       = 10000; // résultats par requête SPARQL
const RATE_LIMIT_MS   = 2500;  // pause entre requêtes pour respecter le rate-limit Wikidata

// Articles avec une année dans le titre = instance spécifique non-devinable
const TITLE_YEAR_RE = /\b(1[0-9]{3}|20[0-9]{2})\b/;

// Types Wikidata P31 à exclure (mêmes que dans game.js)
const WD_SKIP_P31 = new Set([
    'Q18536594', // édition des Jeux olympiques
    'Q82414',    // Jeux olympiques (générique)
    'Q159821',   // jeux olympiques d'hiver
    'Q27020041', // saison sportive
    'Q40231',    // élection
    'Q179187',   // élection législative
    'Q28108',    // élection présidentielle
    'Q80930',    // élection régionale
    'Q3839081',  // édition d'un tournoi
    'Q16521',    // taxon
    'Q7187',     // gène
    'Q8054',     // protéine
    'Q215380',   // groupe musical (trop souvent obscur)
    'Q4167836',  // catégorie Wikimedia
    'Q4167410',  // page de désambiguïsation
    'Q11266439', // modèle Wikimedia
    'Q13442814', // article scientifique
]);

async function sparqlFetch(query) {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
    const r = await fetch(url, {
        headers: {
            'Accept'    : 'application/sparql-results+json',
            'User-Agent': 'QuizzWikiBuild/1.0 (https://github.com/vicoolz/quizz_wiki)',
        },
    });
    if (!r.ok) {
        const body = await r.text();
        throw new Error(`SPARQL ${r.status}: ${body.slice(0, 200)}`);
    }
    return r.json();
}

/**
 * Récupère les Q-IDs Wikidata pour un lot de titres frwiki,
 * et retourne ceux dont P31 n'est pas dans WD_SKIP_P31.
 */
async function filterByP31(entries) {
    const WD_API = 'https://www.wikidata.org/w/api.php';
    const CHUNK  = 50;
    const kept   = [];

    for (let i = 0; i < entries.length; i += CHUNK) {
        const chunk = entries.slice(i, i + CHUNK);
        process.stderr.write(`   P31 check ${i}/${entries.length}... `);
        try {
            const params = new URLSearchParams({
                action: 'wbgetentities',
                sites : 'frwiki',
                titles: chunk.map(([t]) => t).join('|'),
                props : 'claims|sitelinks',
                format: 'json',
            });
            const r = await fetch(`${WD_API}?${params}`, {
                headers: { 'User-Agent': 'QuizzWikiBuild/1.0' },
            });
            if (!r.ok) { kept.push(...chunk); continue; }
            const d = await r.json();

            for (const ent of Object.values(d?.entities || {})) {
                if (ent.missing !== undefined) continue;
                const p31vals = (ent.claims?.P31 || []).map(
                    c => c?.mainsnak?.datavalue?.value?.id
                ).filter(Boolean);
                if (p31vals.some(id => WD_SKIP_P31.has(id))) continue;
                const frTitle = ent.sitelinks?.frwiki?.title;
                if (!frTitle) continue;
                // Chercher le sitelinks count correspondant dans le chunk
                const match = chunk.find(([t]) => t === frTitle)
                           || chunk.find(([t]) => t.toLowerCase() === frTitle.toLowerCase());
                if (match) kept.push(match);
            }
            process.stderr.write(`OK (${kept.length - (kept.length - (kept.length))} gardés)\n`);
        } catch (e) {
            process.stderr.write(`ERREUR (conservés par défaut): ${e.message}\n`);
            kept.push(...chunk); // fail-safe : garder en cas d'erreur
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return kept;
}

async function main() {
    const allEntries = []; // [title, sitelinks]
    let offset = 0;

    console.error('');
    console.error('🔎 Récupération des articles depuis Wikidata SPARQL...');
    console.error(`   Seuil : ${MIN_SITELINKS} sitelinks minimum`);
    console.error(`   Cible : ${TARGET} articles`);
    console.error('');

    // ─── Phase 1 : SPARQL — titres + sitelinks ───────────────────────────────
    while (allEntries.length < TARGET) {
        process.stderr.write(`📄 Page offset=${offset} ... `);
        const query = `
SELECT ?title ?sl WHERE {
  ?item wikibase:sitelinks ?sl .
  FILTER(?sl >= ${MIN_SITELINKS})
  ?article schema:about ?item ;
           schema:isPartOf <https://fr.wikipedia.org/> ;
           schema:name ?title .
}
ORDER BY DESC(?sl)
LIMIT ${PAGE_SIZE}
OFFSET ${offset}`;

        let rows;
        try {
            const data = await sparqlFetch(query);
            rows = data.results.bindings;
        } catch (e) {
            console.error(`\n❌ Erreur SPARQL : ${e.message}`);
            if (allEntries.length < 1000) { process.exit(1); }
            console.error("   On continue avec ce qu'on a deja.");
            break;
        }

        let added = 0;
        for (const row of rows) {
            const title = row.title?.value;
            const sl    = parseInt(row.sl?.value ?? '0', 10);
            if (title && !TITLE_YEAR_RE.test(title)) {
                allEntries.push([title, sl]);
                added++;
            }
        }
        process.stderr.write(`${rows.length} résultats, ${added} retenus (total: ${allEntries.length})\n`);

        if (rows.length < PAGE_SIZE) break; // dernière page
        offset += PAGE_SIZE;
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
    }

    console.error('');
    console.error(`✅ Phase 1 terminée : ${allEntries.length} candidats`);

    // ─── Phase 2 : filtre P31 par batch API Wikidata ─────────────────────────
    console.error('');
    console.error('🔬 Phase 2 : filtrage P31 (types non-devinables)...');
    const filtered = await filterByP31(allEntries);
    console.error(`✅ Phase 2 terminée : ${filtered.length} articles retenus`);

    // ─── Écriture du fichier ─────────────────────────────────────────────────
    const { writeFileSync } = await import('node:fs');
    const now        = new Date().toISOString().slice(0, 10);
    const body       = JSON.stringify(filtered);

    writeFileSync(OUT_FILE,
`// Généré automatiquement par : node build-articles.js
// Ne pas modifier manuellement — relancer le script pour mettre à jour.
// Dernière génération : ${now}
// ${filtered.length} articles éligibles (sitelinks >= ${MIN_SITELINKS}, sans année, P31 filtré)
const ARTICLES = ${body};
`);

    console.error('');
    console.error(`🎉 ${OUT_FILE} écrit avec ${filtered.length} articles.`);
    console.error(`   Rotation sur ${Math.floor(filtered.length / 10)} jours (~${Math.round(filtered.length / 10 / 365)} ans).`);
    console.error('');
    console.error('   Commit suggéré :');
    console.error('   git add articles.js && git commit -m "data: regenerate articles pool"');
}

main().catch(e => {
    console.error('❌ Erreur fatale :', e);
    process.exit(1);
});
