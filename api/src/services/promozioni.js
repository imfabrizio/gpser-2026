// Dal comitato alla regione: il comitato propone scene o schede, l'approvatore della regione le accetta e le cataloga.
// Poi la regione decide a chi renderle disponibili: ai propri comitati e/o ad altre regioni (tabella condivisione).
import { httpErr } from './compilazioni.js';
import { enteUtente, regioneDelComitato, èApprovatore } from '../enti.js';
import { duplicaScena } from './scene.js';

const slug = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
const nt = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TIPI_CON_DATA = ['gara', 'olimpiadi', 'allenamento'];

// voci di una scheda: da una scheda di scena oppure da una patologia della libreria
const vociScheda = async (db, k) => k.scena_id !== undefined && k.slot !== undefined
  ? (await db.query('select sezione, testo, is_sep, mb, be, su, "in", ne from scena_scheda_voce where scheda_id=$1 order by ordine', [k.id])).rows
  : (await db.query(`select pv.sezione, v.testo, pv.is_sep, sp.mb, sp.be, sp.su, sp."in", sp.ne from patologia_voce pv join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id where pv.patologia_id=$1 order by pv.ordine`, [k.id])).rows;

// confronto con il catalogo visibile alla regione (generale storico + catalogo regionale)
async function confronta(db, voci, regione) {
  const mie = new Set(voci.map((v) => nt(v.testo)));
  const { rows: cand } = await db.query(`select id, nome from patologia where not bozza and not is_master and comitato is null and (regione is null or regione = $1)`, [regione]);
  let migliore = null;
  for (const c of cand) {
    const altre = (await db.query('select v.testo from patologia_voce pv join voce v on v.id=pv.voce_id where pv.patologia_id=$1', [c.id])).rows.map((r) => nt(r.testo));
    const set = new Set(altre); const inter = [...mie].filter((x) => set.has(x)).length; const unione = new Set([...mie, ...set]).size;
    const j = unione ? inter / unione : 0;
    if (!migliore || j > migliore.j) migliore = { id: c.id, nome: c.nome, j };
  }
  if (migliore && migliore.j === 1) return { stato: 'identica', con: { id: migliore.id, nome: migliore.nome }, somiglianza: 1 };
  if (migliore && migliore.j >= 0.6) return { stato: 'simile', con: { id: migliore.id, nome: migliore.nome }, somiglianza: Math.round(migliore.j * 100) / 100 };
  return { stato: 'nuova', con: null, somiglianza: migliore ? Math.round(migliore.j * 100) / 100 : 0 };
}

import { notifica, approvatoriIds } from '../notifiche.js';
export async function proponi(db, utente, { scenaId, patologiaId }, { tipo, nota, sblocca } = {}) {
  const mio = await enteUtente(db, utente);
  let comitato, schede, origine;
  if (patologiaId) {                                        // scheda della libreria (skill, Mega Code, schede d'esame)
    const { rows: [p] } = await db.query('select id, nome, comitato, regione, bozza from patologia where id=$1', [patologiaId]);
    if (!p) throw httpErr(404, 'scheda inesistente');
    if (p.bozza) throw httpErr(400, 'pubblica la scheda prima di proporla');
    if (!p.comitato) throw httpErr(400, 'è già una scheda generale o di una regione');
    comitato = p.comitato; schede = [{ id: p.id, titolo: p.nome }]; tipo = 'schede';
  } else {
    if (!['scena', 'schede'].includes(tipo)) throw httpErr(400, 'scegli se promuovere la scena intera o solo le schede');
    const { rows: [s] } = await db.query(`select s.id, e.tipo as etipo, e.livello, e.comitato, e.data, e.data_fine, (e.data_fine is null and e.data is null) as senza_data,
        (coalesce(e.data_fine, e.data) < current_date) as passato, to_char(coalesce(e.data_fine, e.data) + 1, 'DD/MM/YYYY') as da_quando from scena s join evento e on e.id=s.evento_id where s.id=$1`, [scenaId]);
    if (!s) throw httpErr(404, 'scena inesistente');
    if (s.livello === 'regione' || s.livello === 'nazionale') throw httpErr(400, 'la scena è già di una regione o nazionale: la condividi dal catalogo');
    comitato = s.comitato || mio.comitato;
    if (TIPI_CON_DATA.includes(s.etipo)) {
      if (s.senza_data) throw httpErr(409, 'per condividere serve la data dell\'evento: inseriscila nell\'evento');
      if (!s.passato && !(sblocca === true && utente.admin)) throw httpErr(409, `la scena si può condividere dopo lo svolgimento dell'evento, cioè dal ${s.da_quando}`);
    }
    schede = (await db.query('select * from scena_scheda where scena_id=$1 and not is_master order by slot', [scenaId])).rows;
    if (!schede.length) throw httpErr(400, 'la scena non ha schede da promuovere');
    if ((await db.query(`select 1 from promozione where scena_id=$1 and stato='in_attesa'`, [scenaId])).rowCount) throw httpErr(409, 'c\'è già una proposta in attesa per questa scena');
  }
  if (!comitato) throw httpErr(400, 'non so a quale comitato appartieni: chiedi di impostarlo in anagrafica');
  const regione = await regioneDelComitato(db, comitato);
  if (!regione) throw httpErr(400, `il comitato «${comitato}» non risulta nell'elenco ufficiale: non so a quale regione mandare la proposta`);
  const controllo = [];
  for (const k of schede) controllo.push({ titolo: k.titolo, ...(await confronta(db, await vociScheda(db, patologiaId ? { id: k.id } : k), regione)) });
  const auto = utente.admin || (èApprovatore(utente) && mio.regione === regione);
  const { rows: [p] } = await db.query(
    `insert into promozione (scena_id, patologia_id, tipo, livello, automatica, proposta_da, nota, regione, comitato, controllo) values ($1,$2,$3,'regionale',$4,$5,nullif(trim($6),''),$7,$8,$9) returning *`,
    [scenaId || null, patologiaId || null, tipo, auto, utente.id, nota ?? '', regione, comitato, JSON.stringify(controllo)]);
  if (!auto) await notifica(db, (await approvatoriIds(db, regione)).filter((i) => i !== utente.id), { tipo: 'proposta', titolo: `Nuova proposta dal comitato ${comitato}`, testo: schede.map((k) => k.titolo).filter(Boolean).slice(0, 3).join(', ') || null, link: '/admin.html#libreria' });
  return auto ? approva(db, p.id, utente, {}) : p;
}

async function nuovaPatologia(db, k, da, regione, utenteId) {
  const base = da.patologia_id ? (await db.query('select categoria, categoria2, macro, macro2 from patologia where id=$1', [da.patologia_id])).rows[0] : null;
  let codice = `${slug(regione)}-${slug(k.titolo)}`.slice(0, 60);
  for (let n = 2; (await db.query('select 1 from patologia where codice=$1', [codice])).rowCount; n++) codice = `${codice.replace(/-\d+$/, '')}-${n}`;
  const { rows: [p] } = await db.query(
    `insert into patologia (codice, nome, sigla, is_bls, is_master, is_diu, categoria, categoria2, macro, macro2, gravita, fasce, regione, creata_da)
     values ($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [codice, k.titolo, k.sigla, k.is_bls, k.is_diu, base?.categoria || k.titolo, base?.categoria2 ?? null, k.macro ?? base?.macro ?? null, base?.macro2 ?? null, k.gravita, k.fasce ? JSON.stringify(k.fasce) : null, regione, utenteId]);
  let o = 0;
  for (const v of await vociScheda(db, k)) {
    let { rows: [sc] } = await db.query(
      `select id from scala_punteggio where mb is not distinct from $1 and be is not distinct from $2 and su is not distinct from $3 and "in" is not distinct from $4 and ne is not distinct from $5 order by (codice like '%/%') limit 1`, [v.mb, v.be, v.su, v.in, v.ne]);
    if (!sc) ({ rows: [sc] } = await db.query(`insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6) on conflict (codice) do update set codice=excluded.codice returning id`,
      [`${v.mb ?? '-'}/${v.be ?? '-'}/${v.su ?? '-'}/${v.in ?? '-'}/${v.ne ?? '-'}`, v.mb, v.be, v.su, v.in, v.ne]));
    const { rows: [vc] } = await db.query(`insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo = voce.testo returning id`, [v.testo]);
    await db.query('insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,$6)', [p.id, ++o, v.sezione, vc.id, sc.id, v.is_sep]);
  }
  await db.query(`insert into condivisione (tipo, risorsa_id, regione, origine) values ('patologia',$1,$2,true) on conflict do nothing`, [p.id, regione]);
  return p.id;
}

// evento «catalogo» della regione: contiene le scene approvate (non è un evento vero, resta archiviato)
async function eventoCatalogo(db, regione) {
  const codice = `CAT-${slug(regione)}`.slice(0, 60);
  const { rows: [e] } = await db.query(
    `insert into evento (codice, nome, tipo, livello, regione, archiviato) values ($1,$2,'allenamento','regione',$3,true) on conflict (codice) do update set codice=excluded.codice returning id`,
    [codice, `Catalogo scene · ${regione}`, regione]);
  return e.id;
}

export async function approva(db, id, utente, { escludi = [], comitati = false, regioni = null } = {}) {
  const { rows: [p] } = await db.query('select * from promozione where id=$1 for update', [id]);
  if (!p) throw httpErr(404, 'proposta inesistente');
  if (p.stato !== 'in_attesa') throw httpErr(409, 'proposta già decisa');
  if (!utente.admin) { const mio = await enteUtente(db, utente); if (!èApprovatore(utente) || mio.regione !== p.regione) throw httpErr(403, 'puoi decidere solo le proposte della tua regione'); }
  const schede = p.patologia_id ? (await db.query('select id, nome as titolo, sigla, is_bls, is_diu, gravita, macro, fasce, id as patologia_id from patologia where id=$1', [p.patologia_id])).rows
    : (await db.query('select * from scena_scheda where scena_id=$1 and not is_master order by slot', [p.scena_id])).rows;
  const esito = [], creati = [];
  for (const k of schede) {
    const c = (p.controllo || []).find((x) => x.titolo === k.titolo);
    if (c?.stato === 'identica') { esito.push({ titolo: k.titolo, esito: `già in catalogo: ${c.con.nome}` }); continue; }
    if (escludi.includes(k.titolo)) { esito.push({ titolo: k.titolo, esito: c?.con ? `non aggiunta, si usa: ${c.con.nome}` : 'non aggiunta' }); continue; }
    const pid = await nuovaPatologia(db, p.patologia_id ? { ...k, patologia_id: k.id } : k, p.patologia_id ? { patologia_id: k.id } : k, p.regione, utente.id);
    creati.push({ tipo: 'patologia', id: pid }); esito.push({ titolo: k.titolo, esito: c?.stato === 'simile' ? 'aggiunta come variante' : 'aggiunta' });
  }
  if (p.tipo === 'scena') {
    const evCat = await eventoCatalogo(db, p.regione);
    const { rows: [{ n }] } = await db.query('select count(*)::int as n from scena where evento_id=$1', [evCat]);
    const copia = await duplicaScena(db, { scenaId: p.scena_id, eventoDestId: evCat, nuovoCodice: 'S' + (n + 1).toString(36).toUpperCase().padStart(2, '0') });
    await db.query('update scena set regione=$2 where id=$1', [copia.id, p.regione]);
    await db.query(`insert into condivisione (tipo, risorsa_id, regione, origine) values ('scena',$1,$2,true) on conflict do nothing`, [copia.id, p.regione]);
    creati.push({ tipo: 'scena', id: copia.id });
  }
  for (const r of creati) await impostaCondivisione(db, r.tipo, r.id, p.regione, { comitati, regioni });
  const approvata = (await db.query(`update promozione set stato='approvata', deciso_da=$2, deciso_il=now(), esito=$3 where id=$1 returning *`, [id, utente.id, JSON.stringify(esito)])).rows[0];
  if (approvata.proposta_da && approvata.proposta_da !== utente.id) await notifica(db, approvata.proposta_da, { tipo: 'esito', titolo: 'Proposta approvata', testo: 'La tua proposta è stata catalogata nella libreria della regione.', link: '/admin.html#libreria' });
  return approvata;
}

export async function rifiuta(db, id, utente, motivo) {
  const { rows: [q] } = await db.query('select regione from promozione where id=$1', [id]);
  if (q && !utente.admin) { const mio = await enteUtente(db, utente); if (!èApprovatore(utente) || mio.regione !== q.regione) throw httpErr(403, 'puoi decidere solo le proposte della tua regione'); }
  const { rows: [p] } = await db.query(`update promozione set stato='rifiutata', deciso_da=$2, deciso_il=now(), motivo=nullif(trim($3),'') where id=$1 and stato='in_attesa' returning *`, [id, utente.id, motivo ?? '']);
  if (!p) throw httpErr(409, 'proposta inesistente o già decisa');
  if (p.proposta_da && p.proposta_da !== utente.id) await notifica(db, p.proposta_da, { tipo: 'esito', titolo: 'Proposta rifiutata', testo: p.motivo || null, link: '/admin.html#libreria' });
  return p;
}

export async function tutteLeRegioni(db) {
  const { rows } = await db.query(`select distinct case when regione ilike 'trentino%' and provincia is not null then regione || ' · ' || provincia else regione end as r from comitato where regione is not null order by 1`);
  return rows.map((x) => x.r);
}

// la regione proprietaria decide: disponibile ai propri comitati? condivisa con quali altre regioni? (regioni = null non cambia nulla; 'tutte' = tutte)
export async function impostaCondivisione(db, tipo, id, regioneProp, { comitati, regioni }) {
  if (comitati !== undefined) await db.query(`insert into condivisione (tipo, risorsa_id, regione, comitati, origine) values ($1,$2,$3,$4,true) on conflict (tipo, risorsa_id, regione) do update set comitati=excluded.comitati`, [tipo, id, regioneProp, !!comitati]);
  if (regioni) {
    const elenco = regioni === 'tutte' ? (await tutteLeRegioni(db)).filter((r) => r !== regioneProp) : regioni.filter((r) => r !== regioneProp);
    await db.query(`delete from condivisione where tipo=$1 and risorsa_id=$2 and not origine and not (regione = any($3::text[]))`, [tipo, id, elenco]);
    for (const r of elenco) await db.query(`insert into condivisione (tipo, risorsa_id, regione) values ($1,$2,$3) on conflict do nothing`, [tipo, id, r]);
  }
}
