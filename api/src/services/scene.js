import { httpErr } from './compilazioni.js';
// Composizione delle scene a partire dalla libreria.
// La scheda di una scena è una COPIA (snapshot) delle voci della patologia,
// con i punteggi risolti dalla scala: da quel momento è indipendente dalla libreria.

const RIGHE_MAX = 62;   // limite di una pagina A4 (voci + intestazioni di sezione)
export const CODICE_SCENA = /^[A-Z0-9]{1,3}$/;

export async function creaScena(db, { eventoId, codice, titolo, ordine = 0 }) {
  if (!CODICE_SCENA.test(codice || '')) throw httpErr(400, 'codice scena: 1-3 caratteri maiuscoli o cifre');
  const { rows } = await db.query(
    `insert into scena (evento_id, codice, titolo, ordine) values ($1,$2,$3,$4) returning *`,
    [eventoId, codice, titolo, ordine]);
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
  if (!pat) throw httpErr(404, 'patologia inesistente');
  const { rows: [scheda] } = await db.query(
    `insert into scena_scheda (scena_id, slot, patologia_id, titolo, sigla, simulatore, is_bls, is_master, is_diu, parametri)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [scenaId, slot, pat.id, titolo || pat.nome, pat.sigla, simulatore, pat.is_bls, pat.is_master, pat.is_diu,
     JSON.stringify(parametri)]);
  await db.query(
    `insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep)
     select $1, pv.ordine, pv.sezione, v.id, v.testo, sp.codice, sp.mb, sp.be, sp.su, sp."in", sp.ne, pv.is_sep
     from patologia_voce pv
     join voce v on v.id = pv.voce_id
     join scala_punteggio sp on sp.id = pv.scala_id
     where pv.patologia_id = $2`, [scheda.id, pat.id]);
  const { rows: [{ righe }] } = await db.query(
    `select count(*)::int + count(distinct sezione)::int as righe from scena_scheda_voce where scheda_id=$1`, [scheda.id]);
  if (righe > RIGHE_MAX) throw httpErr(400, `la scheda "${scheda.titolo}" avrebbe ${righe} righe: troppe per una pagina (max ${RIGHE_MAX})`);
  for (const o of overrides) {
    await db.query(
      `update scena_scheda_voce set
         mb = coalesce($3, mb), be = coalesce($4, be), su = coalesce($5, su),
         "in" = coalesce($6, "in"), ne = coalesce($7, ne), is_sep = coalesce($8, is_sep),
         scala = 'personalizzata'
       where scheda_id = $1 and ordine = $2`,
      [scheda.id, o.ordine, o.mb ?? null, o.be ?? null, o.su ?? null, o.in ?? null, o.ne ?? null, o.is_sep ?? null]);
  }
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
      `insert into scena_scheda (scena_id, slot, patologia_id, titolo, sigla, simulatore, is_bls, is_master, is_diu, parametri)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [nuova.id, sc.slot, sc.patologia_id, sc.titolo, sc.sigla, sc.simulatore, sc.is_bls, sc.is_master, sc.is_diu, sc.parametri]);
    await db.query(
      `insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep)
       select $1, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep
       from scena_scheda_voce where scheda_id = $2`, [n.id, sc.id]);
  }
  return nuova;
}
