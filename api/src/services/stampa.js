import { creaDocumento, disegnaScheda } from '../pdf/scheda.js';
import { disegnaSkill } from '../pdf/skill.js';
import { httpErr } from './compilazioni.js';

/**
 * Genera un PDF con tutte le schede richieste.
 * opts: { eventoId, scenaCodice?, squadraNumeri?[], vuote: bool }
 * Ordine: squadra → scena → slot (come la cartella di stampa attuale).
 */
export async function generaPdfSchede(db, { eventoId, scenaCodice, squadraNumeri, vuote = true }) {
  const { rows: [evento] } = await db.query(`select *, to_char(data,'YYYY-MM-DD') as data_txt from evento where id=$1`, [eventoId]);
  if (!evento) throw httpErr(404, 'evento inesistente');
  const { rows: squadre } = await db.query(
    `select * from squadra where evento_id=$1 and attiva
       and ($2::int[] is null or numero = any($2)) order by numero`, [eventoId, squadraNumeri ?? null]);
  const { rows: scene } = await db.query(
    `select * from scena where evento_id=$1 and ($2::text is null or codice=$2) order by ordine, codice`,
    [eventoId, scenaCodice ?? null]);

  const doc = creaDocumento();
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((r) => doc.on('end', r));
  let pagine = 0;
  for (const sq of squadre) {
    for (const sc of scene) {
      const { rows: schede } = await db.query('select * from scena_scheda where scena_id=$1 order by slot', [sc.id]);
      for (const scheda of schede) {
        const { rows: tutte } = await db.query('select * from scena_scheda_voce where scheda_id=$1 order by ordine', [scheda.id]);
        const voci = tutte.filter((v) => !v.blocco_id);        // le skill incorporate escono su fogli propri, dopo la scheda
        let compilazione = null; const risposte = new Map();
        if (!vuote) {
          ({ rows: [compilazione] } = await db.query('select * from compilazione where scheda_id=$1 and squadra_id=$2', [scheda.id, sq.id]));
          if (compilazione) {
            const { rows } = await db.query('select voce_id, livello from risposta where compilazione_id=$1', [compilazione.id]);
            rows.forEach((r) => risposte.set(r.voce_id, r.livello));
          }
        }
        disegnaScheda(doc, { evento, squadra: sq, scena: sc, scheda, voci, compilazione, risposte, vuota: vuote });
        pagine++;
        for (const bid of new Set(tutte.filter((v) => v.blocco_id).map((v) => v.blocco_id))) {
          const bv = tutte.filter((v) => v.blocco_id === bid), { rows: [pt] } = await db.query('select sigla, fasce, errori_gravi from patologia where id=$1', [bid]);
          disegnaSkill(doc, { titolo: bv[0].blocco_nome, modello: `SKILL ${pt?.sigla ?? ''}`.trim(), voci: bv.map((v) => ({ sezione: v.sezione, testo: v.testo })), fasce: pt?.fasce, erroriGravi: pt?.errori_gravi ?? [], candidato: vuote ? '' : sq.nome });
          pagine++;
        }
      }
    }
  }
  if (!pagine) doc.addPage().text('Nessuna scheda da stampare');
  doc.end();
  await fine;
  return { pdf: Buffer.concat(chunks), pagine };
}
