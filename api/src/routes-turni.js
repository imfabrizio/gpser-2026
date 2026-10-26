// Svolgimento della gara: rotazione (scena di partenza di ogni squadra) e turni (il giudice master apre e chiude la scena per una squadra).
import { inTransazione } from './db.js';
import { httpErr } from './services/compilazioni.js';

const ORG = ['admin', 'organizzazione'];
const CHIUSE = ['completata', 'verificata'];

export function registraTurni(app, pool, { soloOrg }) {
  // ── rotazione e modalità ──
  app.get('/api/eventi/:id/rotazione', { preHandler: soloOrg }, async (req) => {
    const id = req.params.id;
    const { rows: [e] } = await pool.query('select id, modalita from evento where id=$1', [id]); if (!e) throw httpErr(404, 'evento inesistente');
    const [{ rows: scene }, { rows: squadre }] = await Promise.all([
      pool.query('select id, codice, titolo, sosta from scena where evento_id=$1 order by ordine, codice', [id]),
      pool.query('select id, numero, nome, partenza_scena_id from squadra where evento_id=$1 and attiva order by numero', [id])]);
    return { modalita: e.modalita, scene, squadre };
  });
  app.put('/api/eventi/:id/rotazione', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const id = req.params.id, b = req.body || {};
    const { rows: [e] } = await db.query('select id from evento where id=$1 for update', [id]); if (!e) throw httpErr(404, 'evento inesistente');
    if (b.modalita !== undefined) {
      if (!['online', 'cartacea'].includes(b.modalita)) throw httpErr(400, 'modalità: online o cartacea');
      await db.query('update evento set modalita=$2, updated_at=now() where id=$1', [id, b.modalita]);
    }
    const { rows: scene } = await db.query('select id from scena where evento_id=$1 order by ordine, codice', [id]);
    const { rows: squadre } = await db.query('select id from squadra where evento_id=$1 and attiva order by numero', [id]);
    if (b.auto) {                      // le squadre, in ordine di numero, sulle posizioni in ordine (scene di gioco e soste)
      if (!scene.length) throw httpErr(400, 'la gara non ha ancora scene');
      for (const [i, q] of squadre.entries()) await db.query('update squadra set partenza_scena_id=$2 where id=$1', [q.id, scene[i % scene.length].id]);
    } else if (b.partenze && typeof b.partenze === 'object') {
      const valide = new Set(scene.map((s) => s.id)), mie = new Set(squadre.map((q) => q.id));
      const usate = new Map();
      for (const [sq, sc] of Object.entries(b.partenze)) {
        if (!mie.has(sq)) throw httpErr(400, 'squadra non di questo evento');
        if (sc !== null && !valide.has(sc)) throw httpErr(400, 'scena non di questo evento');
        if (sc) { if (usate.has(sc)) throw httpErr(400, 'due squadre non possono partire dalla stessa scena'); usate.set(sc, sq); }
      }
      for (const [sq, sc] of Object.entries(b.partenze)) await db.query('update squadra set partenza_scena_id=$2 where id=$1', [sq, sc]);
    }
    const { rows: [r] } = await db.query('select modalita from evento where id=$1', [id]);
    return { modalita: r.modalita, squadre: (await db.query('select id, numero, partenza_scena_id from squadra where evento_id=$1 and attiva order by numero', [id])).rows };
  }));

  // ── turni: squadre in corso sulle scene (li vedono tutti i registrati: i giudici capiscono quale squadra valutare) ──
  app.get('/api/eventi/:id/turni', async (req) => (await pool.query(
    `select t.scena_id, sc.codice as scena, t.squadra_id, sq.numero, sq.nome, t.stato from scena_turno t join scena sc on sc.id=t.scena_id join squadra sq on sq.id=t.squadra_id
      where sc.evento_id=$1 and t.stato in ('aperta','attesa') order by sc.ordine, sc.codice`, [req.params.id])).rows);

  const scenaDi = async (db, id) => {
    const { rows: [s] } = await db.query('select sc.id, sc.codice, sc.titolo, sc.sosta, sc.evento_id, e.modalita from scena sc join evento e on e.id=sc.evento_id where sc.id=$1', [id]);
    if (!s) throw httpErr(404, 'scena inesistente'); return s;
  };
  const comanda = async (db, utente, scenaId) => {      // organizzazione, oppure giudice master di quella scena
    if (ORG.includes(utente.ruolo)) return;
    const ok = utente.ruolo === 'giudice_master' && (await db.query('select 1 from scena_master where scena_id=$1 and utente_id=$2', [scenaId, utente.id])).rowCount > 0;
    if (!ok) throw httpErr(403, 'solo il giudice master della scena o l\'organizzazione');
  };
  const schedeDelTurno = async (db, scenaId, squadraId) => (await db.query(
    `select s.id, s.titolo, s.simulatore, c.stato,
            (select coalesce(string_agg(u.nome, ', ' order by u.nome), '') from assegnazione a join utente u on u.id=a.utente_id where a.scheda_id=s.id) as giudici
       from scena_scheda s left join compilazione c on c.scheda_id=s.id and c.squadra_id=$2 where s.scena_id=$1 order by s.slot`, [scenaId, squadraId])).rows;

  // stato della scena per il master: squadra in corso e consegna delle schede
  app.get('/api/scene/:id/turno', async (req) => {
    const sc = await scenaDi(pool, req.params.id); await comanda(pool, req.utente, sc.id);
    const { rows: [t] } = await pool.query(`select t.squadra_id, sq.numero, sq.nome, t.aperta_at from scena_turno t join squadra sq on sq.id=t.squadra_id where t.scena_id=$1 and t.stato='aperta'`, [sc.id]);
    return { scena: sc.codice, modalita: sc.modalita, turno: t || null, schede: t ? await schedeDelTurno(pool, sc.id, t.squadra_id) : [] };
  });
  app.post('/api/scene/:id/apri', async (req) => inTransazione(pool, async (db) => {
    const sc = await scenaDi(db, req.params.id); await comanda(db, req.utente, sc.id);
    if (sc.modalita !== 'online') throw httpErr(409, 'la gara è cartacea: le schede si inseriscono in differita');
    if (sc.sosta) throw httpErr(409, 'una sosta non ha valutazioni');
    const sq = req.body?.squadra_id;
    const { rows: [q] } = await db.query('select id, numero, nome, attiva from squadra where id=$1 and evento_id=$2', [sq, sc.evento_id]);
    if (!q || !q.attiva) throw httpErr(400, 'scegli una squadra della gara');
    const { rows: [altra] } = await db.query(`select s2.codice from scena_turno t join scena s2 on s2.id=t.scena_id where t.squadra_id=$1 and t.stato='aperta'`, [q.id]);
    if (altra) throw httpErr(409, `la squadra ${q.numero} è già in corso sulla scena ${altra.codice}`);
    const { rows: [occ] } = await db.query(`select sq.numero from scena_turno t join squadra sq on sq.id=t.squadra_id where t.scena_id=$1 and t.stato='aperta'`, [sc.id]);
    if (occ) throw httpErr(409, `sulla scena c'è già la squadra ${occ.numero}: chiudila prima`);
    const { rows: [gia] } = await db.query(`select 1 from scena_turno where scena_id=$1 and squadra_id=$2 and stato='chiusa'`, [sc.id, q.id]);
    if (gia) throw httpErr(409, `la squadra ${q.numero} ha già fatto questa scena`);
    await db.query(`insert into scena_turno (scena_id, squadra_id, stato, aperta_at, aperta_da) values ($1,$2,'aperta',now(),$3)
                    on conflict (scena_id, squadra_id) do update set stato='aperta', aperta_at=now(), aperta_da=$3`, [sc.id, q.id, req.utente.id]);
    return { ok: true, squadra: q.numero };
  }));
  app.post('/api/scene/:id/chiudi', async (req) => inTransazione(pool, async (db) => {
    const sc = await scenaDi(db, req.params.id); await comanda(db, req.utente, sc.id);
    const { rows: [t] } = await db.query(`select t.squadra_id, sq.numero from scena_turno t join squadra sq on sq.id=t.squadra_id where t.scena_id=$1 and t.stato='aperta' for update of t`, [sc.id]);
    if (!t) throw httpErr(409, 'nessuna squadra in corso su questa scena');
    const mancano = (await schedeDelTurno(db, sc.id, t.squadra_id)).filter((k) => !CHIUSE.includes(k.stato));
    if (mancano.length) throw httpErr(409, 'non si può chiudere: mancano ' + mancano.map((k) => `${k.titolo} (sim. ${k.simulatore})${k.giudici ? ' – ' + k.giudici : ''}`).join('; '));
    await db.query(`update scena_turno set stato='chiusa', chiusa_at=now(), chiusa_da=$3 where scena_id=$1 and squadra_id=$2`, [sc.id, t.squadra_id, req.utente.id]);
    return { ok: true, squadra: t.numero };
  }));
}
