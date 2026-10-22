// Segreteria: iscritti alla gara, registrazione degli arrivi, badge.
import { httpErr } from './services/compilazioni.js';
import { generaBadge } from './pdf/badge.js';
import { RUOLI_BADGE, SENZA_SQUADRA_OK } from './ruoli-gara.js';

const testo = (x, max = 80) => (typeof x === 'string' && x.trim() ? x.trim().replace(/\s+/g, ' ').slice(0, max) : null);
const UUID = /^[0-9a-f-]{36}$/i;

export function registraSegreteria(app, pool, { soloOrg }) {
  const SEL = `select i.id, i.evento_id, i.ruolo, i.squadra_id, s.nome as squadra, s.numero as squadra_numero, i.arrivato_at, ua.nome as arrivato_da,
      p.id as persona_id, p.cognome, p.nome, p.comitato, p.provincia
    from iscrizione i join partecipante p on p.id = i.partecipante_id left join squadra s on s.id = i.squadra_id left join utente ua on ua.id = i.arrivato_da`;
  const ruoloOk = (r) => { if (!RUOLI_BADGE[r]) throw httpErr(400, 'ruolo non valido'); return r; };
  const squadraDi = async (db, evento, id) => {
    if (!id) return null;
    const { rowCount } = await db.query('select 1 from squadra where id=$1 and evento_id=$2', [id, evento]);
    if (!rowCount) throw httpErr(400, 'squadra non valida per questa gara');
    return id;
  };

  app.get('/api/eventi/:id/iscritti', { preHandler: soloOrg }, async (req) => {
    const { rows } = await pool.query(SEL + ' where i.evento_id=$1 order by p.cognome, p.nome', [req.params.id]);
    const { rows: [ev] } = await pool.query('select formato_badge_id from evento where id=$1', [req.params.id]);
    if (!ev) throw httpErr(404, 'gara inesistente');
    const per = {};
    for (const r of rows) { const x = (per[r.ruolo] ||= { tot: 0, arr: 0 }); x.tot++; if (r.arrivato_at) x.arr++; }
    return { iscritti: rows, conteggi: { totale: rows.length, arrivati: rows.filter((r) => r.arrivato_at).length, per_ruolo: per },
      ruoli: Object.fromEntries(Object.entries(RUOLI_BADGE).map(([k, v]) => [k, v.nome])), formato_badge_id: ev.formato_badge_id };
  });

  // l'iscrizione può nascere da una persona dell'anagrafica o da un nuovo arrivato scritto al banco
  app.post('/api/eventi/:id/iscritti', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, ruolo = ruoloOk(b.ruolo || 'partecipante_membro');
    const { rowCount: ev } = await pool.query('select 1 from evento where id=$1', [req.params.id]); if (!ev) throw httpErr(404, 'gara inesistente');
    const squadra = await squadraDi(pool, req.params.id, b.squadra_id);
    if (!squadra && !SENZA_SQUADRA_OK.includes(ruolo)) throw httpErr(400, 'per questo ruolo scegli la squadra');
    let pid = b.partecipante_id;
    if (pid) { if (!UUID.test(pid) || !(await pool.query('select 1 from partecipante where id=$1', [pid])).rowCount) throw httpErr(400, 'persona inesistente'); }
    else {
      const cognome = testo(b.cognome), nome = testo(b.nome), comitato = testo(b.comitato, 120), provincia = testo(b.provincia, 4)?.toUpperCase() ?? null;
      if (!cognome || !nome) throw httpErr(400, 'cognome e nome obbligatori');
      const { rows: [esiste] } = await pool.query(
        `select id from partecipante where lower(cognome)=lower($1) and lower(nome)=lower($2) and coalesce(lower(comitato),'') = coalesce(lower($3),'') limit 1`, [cognome, nome, comitato]);
      pid = esiste?.id || (await pool.query('insert into partecipante (cognome, nome, comitato, provincia) values ($1,$2,$3,$4) returning id', [cognome, nome, comitato, provincia])).rows[0].id;
    }
    try {
      const { rows: [r] } = await pool.query(
        `insert into iscrizione (evento_id, partecipante_id, ruolo, squadra_id, arrivato_at, arrivato_da) values ($1,$2,$3,$4, case when $5 then now() end, case when $5 then $6::uuid end) returning id`,
        [req.params.id, pid, ruolo, squadra, b.arrivato === true, req.utente.id]);
      return (await pool.query(SEL + ' where i.id=$1', [r.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw httpErr(409, 'la persona è già iscritta a questa gara'); throw e; }
  });

  // iscrive in blocco i componenti delle squadre (anagrafica → squadra) con il ruolo giusto
  app.post('/api/eventi/:id/iscritti/da-squadre', { preHandler: soloOrg }, async (req) => {
    const { rowCount } = await pool.query(
      `insert into iscrizione (evento_id, partecipante_id, ruolo, squadra_id)
       select s.evento_id, m.partecipante_id, case when lower(coalesce(m.ruolo,'')) like '%capo%' then 'partecipante_leader' else 'partecipante_membro' end, s.id
         from squadra_membro m join squadra s on s.id = m.squadra_id where s.evento_id = $1 and s.attiva
       on conflict (evento_id, partecipante_id) do nothing`, [req.params.id]);
    return { aggiunti: rowCount };
  });

  app.patch('/api/iscritti/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [i] } = await pool.query('select * from iscrizione where id=$1', [req.params.id]); if (!i) throw httpErr(404, 'iscrizione inesistente');
    const b = req.body || {};
    const ruolo = b.ruolo ? ruoloOk(b.ruolo) : i.ruolo;
    const squadra = 'squadra_id' in b ? await squadraDi(pool, i.evento_id, b.squadra_id) : i.squadra_id;
    if (!squadra && !SENZA_SQUADRA_OK.includes(ruolo)) throw httpErr(400, 'per questo ruolo scegli la squadra');
    await pool.query('update iscrizione set ruolo=$2, squadra_id=$3 where id=$1', [i.id, ruolo, squadra]);
    return (await pool.query(SEL + ' where i.id=$1', [i.id])).rows[0];
  });
  app.delete('/api/iscritti/:id', { preHandler: soloOrg }, async (req) => {
    const { rowCount } = await pool.query('delete from iscrizione where id=$1', [req.params.id]);
    if (!rowCount) throw httpErr(404, 'iscrizione inesistente'); return { ok: true };
  });

  // arrivo: chi lo ha registrato e quando; ripetere il tocco non cambia l'ora già segnata
  app.post('/api/iscritti/:id/arrivo', { preHandler: soloOrg }, async (req) => {
    const { rows: [x] } = await pool.query('select arrivato_at from iscrizione where id=$1', [req.params.id]); if (!x) throw httpErr(404, 'iscrizione inesistente');
    if (!x.arrivato_at) await pool.query('update iscrizione set arrivato_at=now(), arrivato_da=$2 where id=$1', [req.params.id, req.utente.id]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'arrivo','iscrizione',$2::text)`, [req.utente.id, req.params.id]);
    return (await pool.query(SEL + ' where i.id=$1', [req.params.id])).rows[0];
  });
  app.post('/api/iscritti/:id/annulla-arrivo', { preHandler: soloOrg }, async (req) => {
    const { rowCount } = await pool.query('update iscrizione set arrivato_at=null, arrivato_da=null where id=$1', [req.params.id]);
    if (!rowCount) throw httpErr(404, 'iscrizione inesistente');
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'arrivo_annullato','iscrizione',$2::text)`, [req.utente.id, req.params.id]);
    return (await pool.query(SEL + ' where i.id=$1', [req.params.id])).rows[0];
  });

  // ricerca nell'anagrafica per aggiungere un'iscrizione (solo dati minimi: niente codice fiscale)
  app.get('/api/segreteria/persone', { preHandler: soloOrg }, async (req) => {
    const q = testo(req.query.q); if (!q || q.length < 2) return [];
    return (await pool.query(
      `select id, cognome, nome, comitato, provincia from partecipante
        where cognome ilike '%'||$1||'%' or nome ilike '%'||$1||'%' or (cognome||' '||nome) ilike '%'||$1||'%' or comitato ilike '%'||$1||'%' order by cognome, nome limit 30`, [q])).rows;
  });

  // ── formati dei badge ──
  app.get('/api/badge/formati', { preHandler: soloOrg }, async () => (await pool.query('select id, nome, larghezza_mm::float as larghezza_mm, altezza_mm::float as altezza_mm, sistema from formato_badge order by sistema desc, nome')).rows);
  app.post('/api/badge/formati', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, w = Number(b.larghezza_mm), h = Number(b.altezza_mm), nome = testo(b.nome, 40) || `${w} × ${h} mm`;
    if (!(w >= 30 && w <= 300 && h >= 30 && h <= 300)) throw httpErr(400, 'larghezza e altezza tra 30 e 300 mm');
    try { return (await pool.query('insert into formato_badge (nome, larghezza_mm, altezza_mm) values ($1,$2,$3) returning id, nome, larghezza_mm::float as larghezza_mm, altezza_mm::float as altezza_mm, sistema', [nome, w, h])).rows[0]; }
    catch (e) { if (e.code === '23505') throw httpErr(409, 'esiste già un formato con questo nome'); throw e; }
  });
  app.delete('/api/badge/formati/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [f] } = await pool.query('select sistema from formato_badge where id=$1', [req.params.id]); if (!f) throw httpErr(404, 'formato inesistente');
    if (f.sistema) throw httpErr(400, 'i formati già pronti non si eliminano');
    await pool.query('delete from formato_badge where id=$1', [req.params.id]); return { ok: true };
  });
  app.put('/api/eventi/:id/formato-badge', { preHandler: soloOrg }, async (req) => {
    const id = req.body?.formato_badge_id || null;
    if (id && !(await pool.query('select 1 from formato_badge where id=$1', [id])).rowCount) throw httpErr(400, 'formato inesistente');
    const { rowCount } = await pool.query('update evento set formato_badge_id=$2 where id=$1', [req.params.id, id]); if (!rowCount) throw httpErr(404, 'gara inesistente');
    return { ok: true };
  });

  // ── badge PDF: ?iscritto=<id> oppure ?ambito=tutti|arrivati|squadra:<id>|ruolo:<ruolo>  (&formato=<id>) ──
  app.get('/api/eventi/:id/badge.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const q = req.query;
    const { rows: [ev] } = await pool.query('select id, nome, tipo, titolo_stampa, luogo, to_char(data,\'YYYY-MM-DD\') as data, formato_badge_id from evento where id=$1', [req.params.id]);
    if (!ev) throw httpErr(404, 'gara inesistente');
    const fid = q.formato || ev.formato_badge_id;
    const { rows: [formato] } = fid ? await pool.query('select * from formato_badge where id=$1', [fid]) : await pool.query('select * from formato_badge order by sistema desc, created_at limit 1');
    if (!formato) throw httpErr(400, 'formato del badge non valido');
    const cond = ['i.evento_id=$1'], par = [ev.id];
    if (q.iscritto) { if (!UUID.test(q.iscritto)) throw httpErr(400, 'iscritto non valido'); par.push(q.iscritto); cond.push(`i.id=$${par.length}`); }
    else {
      const a = String(q.ambito || 'tutti');
      if (a === 'arrivati') cond.push('i.arrivato_at is not null');
      else if (a.startsWith('squadra:')) { const s = a.slice(8); if (!UUID.test(s)) throw httpErr(400, 'squadra non valida'); par.push(s); cond.push(`i.squadra_id=$${par.length}`); }
      else if (a.startsWith('ruolo:')) { const r = a.slice(6); if (!RUOLI_BADGE[r]) throw httpErr(400, 'ruolo non valido'); par.push(r); cond.push(`i.ruolo=$${par.length}`); }
      else if (a !== 'tutti') throw httpErr(400, 'ambito non valido');
    }
    const { rows } = await pool.query(`${SEL} where ${cond.join(' and ')} order by p.cognome, p.nome`, par);
    if (!rows.length) throw httpErr(404, 'nessun badge da stampare');
    const pdf = await generaBadge({ evento: ev, formato, iscritti: rows });
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="badge.pdf"').send(pdf);
  });
}
