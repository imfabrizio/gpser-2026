import { httpErr } from './compilazioni.js';
// Composizione delle scene a partire dalla libreria.
// La scheda di una scena è una COPIA (snapshot) delle voci della patologia,
// con i punteggi risolti dalla scala: da quel momento è indipendente dalla libreria.

const RIGHE_MAX = 62;   // limite di una pagina A4 (voci + intestazioni di sezione)
export const CODICE_SCENA = /^[A-Z0-9]{1,3}$/;

export async function creaScena(db, { eventoId, codice, titolo, ordine = 0, sosta = false }) {
  if (!CODICE_SCENA.test(codice || '')) throw httpErr(400, 'codice scena: 1-3 caratteri maiuscoli o cifre');
  const { rows } = await db.query(
    `insert into scena (evento_id, codice, titolo, ordine, sosta) values ($1,$2,$3,$4,$5) returning *`,
    [eventoId, codice, titolo, ordine, !!sosta]);
  return rows[0];
}

/**
 * Aggiunge alla scena una scheda basata su una patologia della libreria.
 * overrides: [{ordine, mb, be, su, in, ne, is_sep}] sostituisce i punteggi di singole voci
 *            solo per questa scena (es. peso doppio solo qui).
 */
export async function aggiungiSchedaDaPatologia(db, {
  scenaId, slot, patologiaId, simulatore, parametri = {}, titolo, overrides = [],
}) {
  const { rows: [pat] } = await db.query(`select * from patologia where id = $1`, [patologiaId]);
  if (pat?.bozza) throw httpErr(400, 'scheda in bozza: pubblicala prima di usarla in una scena');
  if (!pat) throw httpErr(404, 'patologia inesistente');
  const { rows: [scheda] } = await db.query(
    `insert into scena_scheda (scena_id, slot, patologia_id, titolo, sigla, simulatore, is_bls, is_master, is_diu, parametri, fasce, gravita, macro)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [scenaId, slot, pat.id, titolo || pat.nome, pat.sigla, simulatore, pat.is_bls, pat.is_master, pat.is_diu,
     JSON.stringify(parametri), pat.fasce ? JSON.stringify(pat.fasce) : null, pat.gravita, pat.macro]);
  await db.query(
    `insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep)
     select $1, pv.ordine, pv.sezione, v.id, v.testo, sp.codice, sp.mb, sp.be, sp.su, sp."in", sp.ne, pv.is_sep
     from patologia_voce pv
     join voce v on v.id = pv.voce_id
     join scala_punteggio sp on sp.id = pv.scala_id
     where pv.patologia_id = $2`, [scheda.id, pat.id]);
  const { rows: [{ righe }] } = await db.query(
    `select count(*)::int + count(distinct sezione)::int as righe from scena_scheda_voce where scheda_id=$1`, [scheda.id]);   // le skill incorporate si stampano a parte: contano solo le voci della scheda
  for (const o of overrides) {
    await db.query(
      `update scena_scheda_voce set
         mb = coalesce($3, mb), be = coalesce($4, be), su = coalesce($5, su),
         "in" = coalesce($6, "in"), ne = coalesce($7, ne), is_sep = coalesce($8, is_sep),
         scala = 'personalizzata'
       where scheda_id = $1 and ordine = $2`,
      [scheda.id, o.ordine, o.mb ?? null, o.be ?? null, o.su ?? null, o.in ?? null, o.ne ?? null, o.is_sep ?? null]);
  }
  // skill incorporate: i loro punteggi restano separati (blocco_id) e le voci si inseriscono dopo la voce indicata (ordine = dopo × 1000 + posizione della skill × 100 + n: più skill possono stare dopo la stessa voce)
  await db.query(
    `insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep, blocco_id, blocco_nome)
     select $1, ps.dopo_ordine * 1000 + dense_rank() over (partition by ps.dopo_ordine order by sk.nome) * 100 + pv.ordine, sk.nome, v.id, v.testo, sp.codice, sp.mb, sp.be, sp.su, sp."in", sp.ne, false, sk.id, sk.nome
       from patologia_skill ps join patologia sk on sk.id = ps.skill_id
       join patologia_voce pv on pv.patologia_id = sk.id join voce v on v.id = pv.voce_id join scala_punteggio sp on sp.id = pv.scala_id
      where ps.patologia_id = $2`, [scheda.id, pat.id]);
  // ordine definitivo 1..n: le voci della scheda valgono ordine × 1000, quelle delle skill dopo × 1000 + n
  const { rowCount: nSkill } = await db.query('select 1 from scena_scheda_voce where scheda_id=$1 and blocco_id is not null limit 1', [scheda.id]);
  if (nSkill) {
    await db.query(`update scena_scheda_voce v set ordine = k.rn + 1000000 from (
        select id, row_number() over (order by case when blocco_id is null then ordine * 1000 else ordine end) as rn from scena_scheda_voce where scheda_id=$1) k where v.id = k.id`, [scheda.id]);
    await db.query('update scena_scheda_voce set ordine = ordine - 1000000 where scheda_id=$1', [scheda.id]);
  }
  if (righe > RIGHE_MAX) throw httpErr(400, `la scheda "${scheda.titolo}" avrebbe ${righe} righe: troppe per una pagina (max ${RIGHE_MAX})`);
  return scheda;
}

/** Duplica una scena (con tutte le schede e le voci) in un altro evento: "parti da un template". */
export async function duplicaScena(db, { scenaId, eventoDestId, nuovoCodice }) {
  const { rows: [s] } = await db.query(`select * from scena where id=$1`, [scenaId]);
  if (!s) throw httpErr(404, 'scena inesistente');
  const nuova = await creaScena(db, {
    eventoId: eventoDestId, codice: nuovoCodice ?? s.codice, titolo: s.titolo, ordine: s.ordine });
  const { rows: schede } = await db.query(`select * from scena_scheda where scena_id=$1`, [scenaId]);
  for (const sc of schede) {
    const { rows: [n] } = await db.query(
      `insert into scena_scheda (scena_id, slot, patologia_id, titolo, sigla, simulatore, is_bls, is_master, is_diu, parametri, fasce, gravita, macro)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [nuova.id, sc.slot, sc.patologia_id, sc.titolo, sc.sigla, sc.simulatore, sc.is_bls, sc.is_master, sc.is_diu, sc.parametri, sc.fasce ? JSON.stringify(sc.fasce) : null, sc.gravita, sc.macro]);
    await db.query(
      `insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep, blocco_id, blocco_nome)
       select $1, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep, blocco_id, blocco_nome
       from scena_scheda_voce where scheda_id = $2`, [n.id, sc.id]);
  }
  return nuova;
}

const RANGO_GRAVITA = { rosso: 0, giallo: 1, verde: 2 };
const VOCE_PAZIENTE = /^\s*\d+\s*[–—-]\s*\S/;

/**
 * Compila nel Master l'elenco dei pazienti della scena (voci «1 – Ictus», «2 – …») in ordine di gravità
 * (rosso, giallo, verde) e, a parità, di priorità della categoria, poi di posizione. Sostituisce le voci già
 * scritte in quel formato; se non ce ne sono le inserisce dopo «descrive l'evento».
 */
export async function aggiornaElencoPazienti(db, scenaId) {
  const { rows: [master] } = await db.query('select id from scena_scheda where scena_id=$1 and is_master', [scenaId]);
  if (!master) throw httpErr(400, 'la scena non ha la scheda Master');
  const { rows: pz } = await db.query(
    `select s.titolo, s.slot, s.gravita, coalesce(m.priorita, 99) as prio from scena_scheda s left join macro_categoria m on m.codice = s.macro
      where s.scena_id=$1 and not s.is_master`, [scenaId]);
  pz.sort((a, b) => (RANGO_GRAVITA[a.gravita] ?? 3) - (RANGO_GRAVITA[b.gravita] ?? 3) || a.prio - b.prio || a.slot - b.slot);
  const testi = pz.map((p, i) => `${i + 1} – ${p.titolo}`);
  const { rows: voci } = await db.query('select * from scena_scheda_voce where scheda_id=$1 order by ordine', [master.id]);
  const idx = voci.map((v, i) => (VOCE_PAZIENTE.test(v.testo) ? i : -1)).filter((i) => i >= 0);
  let punto, modello;
  if (idx.length) { punto = idx[0]; modello = voci[idx[0]]; }
  else {
    const d = voci.findIndex((v) => /descrive.*evento/i.test(v.testo));
    if (d < 0) throw httpErr(400, 'nel Master non trovo dove mettere l\'elenco: aggiungi una voce «1 – …» dopo la descrizione dell\'evento');
    punto = d + 1; modello = voci[d];
  }
  const { rows: [{ n: conRisposte }] } = await db.query('select count(*)::int n from risposta r join scena_scheda_voce v on v.id=r.voce_id where v.scheda_id=$1', [master.id]);
  if (conRisposte && testi.length !== idx.length) throw httpErr(409, 'il Master ha già delle valutazioni e il numero di pazienti è cambiato: non posso rinumerare le voci');
  if (conRisposte || (idx.length && testi.length === idx.length)) {       // stesso numero di voci: si aggiorna solo il testo
    for (const [k, i] of idx.entries()) {
      const { rows: [v] } = await db.query(`insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo=voce.testo returning id`, [testi[k]]);
      await db.query('update scena_scheda_voce set testo=$2, voce_id=$3 where id=$1', [voci[i].id, testi[k], v.id]);
    }
    return { pazienti: testi };
  }
  // numero diverso e nessuna valutazione: si ricostruisce l'elenco delle voci del Master
  const prima = voci.filter((_, i) => i < punto && !idx.includes(i));
  const dopo = voci.filter((_, i) => i >= punto && !idx.includes(i));
  await db.query('delete from scena_scheda_voce where scheda_id=$1', [master.id]);
  let ord = 0;
  const inserisci = async (v) => db.query(
    `insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [master.id, ++ord, v.sezione, v.voce_id, v.testo, v.scala, v.mb, v.be, v.su, v.in, v.ne, v.is_sep]);
  for (const v of prima) await inserisci(v);
  for (const t of testi) {
    const { rows: [vc] } = await db.query(`insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo=voce.testo returning id`, [t]);
    await inserisci({ ...modello, voce_id: vc.id, testo: t });
  }
  for (const v of dopo) await inserisci(v);
  return { pazienti: testi };
}
