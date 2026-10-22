// Risorse della gara: quanti giudici, simulatori e truccatori servono e dove sono assegnati.
import { httpErr } from './services/compilazioni.js';

const UUID = /^[0-9a-f-]{36}$/i;
const RUOLI_RISORSA = ['giudice', 'giudice_master', 'simulatore', 'truccatore'];
const SIM_TRUC = ['simulatore', 'truccatore'];

export function registraRisorse(app, pool, { inTransazione, soloOrg }) {
  app.get('/api/eventi/:id/risorse', { preHandler: soloOrg }, async (req) => {
    const ev = req.params.id;
    if (!UUID.test(ev)) throw httpErr(400, 'id non valido');
    const [{ rows: persone }, { rows: scene }, { rows: ass }, { rows: mas }, { rows: ris }] = await Promise.all([
      pool.query(`select i.id, i.ruolo, i.arrivato_at, p.cognome, p.nome, p.comitato, p.utente_id
                    from iscrizione i join partecipante p on p.id = i.partecipante_id
                   where i.evento_id = $1 and i.ruolo = any($2) order by p.cognome, p.nome`, [ev, RUOLI_RISORSA]),
      pool.query(`select id, codice, titolo from scena where evento_id=$1 order by ordine, codice`, [ev]),
      pool.query(`select a.scheda_id, ss.scena_id, ss.titolo, a.utente_id, u.nome
                    from assegnazione a join scena_scheda ss on ss.id = a.scheda_id join scena sc on sc.id = ss.scena_id
                    join utente u on u.id = a.utente_id where sc.evento_id=$1`, [ev]),
      pool.query(`select m.scena_id, m.utente_id, u.nome from scena_master m join scena sc on sc.id = m.scena_id join utente u on u.id = m.utente_id where sc.evento_id=$1`, [ev]),
      pool.query(`select r.scena_id, r.iscrizione_id from scena_risorsa r join scena sc on sc.id = r.scena_id where sc.evento_id=$1`, [ev]),
    ]);
    const { rows: schede } = await pool.query(
      `select ss.id, ss.scena_id, ss.titolo from scena_scheda ss join scena sc on sc.id = ss.scena_id where sc.evento_id=$1 order by ss.slot`, [ev]);
    const scenePer = (iscr) => ris.filter((r) => r.iscrizione_id === iscr).map((r) => r.scena_id);
    const sceneGiudice = (uid) => [...new Set([...ass.filter((a) => a.utente_id === uid).map((a) => a.scena_id), ...mas.filter((m) => m.utente_id === uid).map((m) => m.scena_id)])];
    const elenco = persone.map((p) => ({
      ...p, scene: SIM_TRUC.includes(p.ruolo) ? scenePer(p.id) : (p.utente_id ? sceneGiudice(p.utente_id) : []),
    }));
    const conteggi = {};
    for (const r of RUOLI_RISORSA) {
      const l = elenco.filter((p) => p.ruolo === r);
      conteggi[r] = { totale: l.length, arrivati: l.filter((p) => p.arrivato_at).length, assegnati: l.filter((p) => p.scene.length).length,
        senza_account: SIM_TRUC.includes(r) ? 0 : l.filter((p) => !p.utente_id).length };
    }
    return {
      conteggi, persone: elenco,
      scene: scene.map((s) => ({
        ...s,
        master: mas.filter((m) => m.scena_id === s.id).map((m) => ({ utente_id: m.utente_id, nome: m.nome })),
        schede: schede.filter((k) => k.scena_id === s.id).map((k) => ({ id: k.id, titolo: k.titolo, giudici: ass.filter((a) => a.scheda_id === k.id).map((a) => ({ utente_id: a.utente_id, nome: a.nome })) })),
        risorse: ris.filter((r) => r.scena_id === s.id).map((r) => r.iscrizione_id),
      })),
    };
  });

  // simulatori e truccatori di una scena (sostituisce l'elenco)
  app.put('/api/scene/:id/risorse', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const { rows: [sc] } = await db.query('select id, evento_id from scena where id=$1', [req.params.id]);
    if (!sc) throw httpErr(404, 'scena inesistente');
    const ids = req.body?.iscrizioni;
    if (!Array.isArray(ids) || ids.some((x) => !UUID.test(x))) throw httpErr(400, 'elenco non valido');
    const uniq = [...new Set(ids)];
    if (uniq.length) {
      const { rows } = await db.query('select count(*)::int n from iscrizione where id = any($1::uuid[]) and evento_id=$2 and ruolo = any($3)', [uniq, sc.evento_id, SIM_TRUC]);
      if (rows[0].n !== uniq.length) throw httpErr(400, 'solo simulatori e truccatori iscritti a questa gara');
    }
    await db.query('delete from scena_risorsa where scena_id=$1', [sc.id]);
    for (const i of uniq) await db.query('insert into scena_risorsa values ($1,$2)', [sc.id, i]);
    return { ok: true, assegnati: uniq.length };
  }));
}
