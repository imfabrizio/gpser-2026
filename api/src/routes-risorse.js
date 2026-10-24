// Risorse della gara: quanti giudici, simulatori e truccatori servono e dove sono assegnati.
import crypto from 'node:crypto';
import { hashPassword } from './auth.js';
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

  // crea l'accesso di un giudice iscritto alla gara: solo Google/Microsoft con la sua email, senza poteri propri;
  // il suo accesso vale per le gare a cui è iscritto come giudice o giudice master
  app.post('/api/iscrizioni/:id/accesso', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    if (!UUID.test(req.params.id)) throw httpErr(400, 'id non valido');
    const { rows: [p] } = await db.query(`select i.ruolo, p.id as pid, p.email, p.nome, p.cognome, p.utente_id from iscrizione i join partecipante p on p.id = i.partecipante_id where i.id=$1`, [req.params.id]);
    if (!p) throw httpErr(404, 'iscrizione inesistente');
    if (!['giudice', 'giudice_master'].includes(p.ruolo)) throw httpErr(400, 'l\'accesso serve ai giudici e ai giudici master');
    if (p.utente_id) return { ok: true, esistente: true };
    const email = (p.email || '').trim();
    if (!email) throw httpErr(400, 'serve l\'email della persona: scrivila in anagrafica, sarà il suo login');
    let { rows: [u] } = await db.query('select id from utente where lower(email)=lower($1)', [email]);
    if (!u) ({ rows: [u] } = await db.query(`insert into utente (email, nome, ruolo, password_hash) values ($1,$2,'partecipante',$3) returning id`,
      [email, `${p.nome} ${p.cognome}`.trim(), hashPassword(crypto.randomBytes(24).toString('base64url'))]));
    await db.query('update partecipante set utente_id=$1 where id=$2 and utente_id is null', [u.id, p.pid]);
    return { ok: true, utente_id: u.id };
  }));

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
