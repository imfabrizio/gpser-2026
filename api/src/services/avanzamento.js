// Avanzamento della gara: per ogni squadra e scena lo stato (da fare, in attesa, prossima, in corso, fatta; per le soste: ora, passata).
export async function calcolaAvanzamento(pool, id) {
    const [{ rows: scene }, { rows: squadre }, { rows: righe }, { rows: turni }, { rows: [ev] }] = await Promise.all([
      pool.query('select id, codice, titolo, sosta, ordine from scena where evento_id=$1 order by ordine, codice', [id]),
      pool.query('select id, numero, nome, partenza_scena_id from squadra where evento_id=$1 and attiva order by numero', [id]),
      pool.query(`select sc.codice as scena, sq.numero as squadra, c.stato from scena sc join scena_scheda s on s.scena_id=sc.id
                    join squadra sq on sq.evento_id=sc.evento_id and sq.attiva left join compilazione c on c.scheda_id=s.id and c.squadra_id=sq.id where sc.evento_id=$1`, [id]),
      pool.query(`select sc.codice as scena, sq.numero as squadra, t.stato from scena_turno t join scena sc on sc.id=t.scena_id join squadra sq on sq.id=t.squadra_id where sc.evento_id=$1`, [id]),
      pool.query('select modalita from evento where id=$1', [id])]);
    const celle = {};
    for (const r of righe) {
      const c = ((celle[r.squadra] ??= {})[r.scena] ??= { totali: 0, fatte: 0, iniziate: 0 });
      c.totali++; if (r.stato) c.iniziate++; if (r.stato === 'completata' || r.stato === 'verificata') c.fatte++;
    }
    for (const sq of Object.values(celle)) for (const c of Object.values(sq)) c.stato = c.fatte === c.totali ? 'fatta' : c.iniziate ? 'in_corso' : 'da_fare';
    // gara online: il turno aperto dal master è «in corso», quello chiuso è «fatta»
    for (const t of turni) {
      const c = ((celle[t.squadra] ??= {})[t.scena] ??= { totali: 0, fatte: 0, iniziate: 0, stato: 'da_fare' });
      if (t.stato === 'aperta') c.stato = 'in_corso'; else if (t.stato === 'chiusa') c.stato = 'fatta'; else if (t.stato === 'attesa' && c.stato === 'da_fare') c.stato = 'attesa';
    }
    // rotazione: dalla scena di partenza si procede in ordine; le soste sono «passate» o «ora», la prossima scena di gioco è «prossima»
    const n = scene.length;
    for (const q of squadre) {
      const p0 = scene.findIndex((s) => s.id === q.partenza_scena_id); if (p0 < 0) continue;
      const seq = scene.map((_, i) => scene[(p0 + i) % n]);
      let k = 0;
      seq.forEach((s, i) => { if (!s.sosta && celle[q.numero]?.[s.codice]?.stato === 'fatta') k = i + 1; });
      const riga = (celle[q.numero] ??= {});
      for (const [i, s] of seq.entries()) {
        const c = (riga[s.codice] ??= { totali: 0, fatte: 0, iniziate: 0, stato: 'da_fare' });
        if (s.sosta) c.stato = i < k ? 'passata' : i === k && !seq.some((x) => riga[x.codice]?.stato === 'in_corso') ? 'ora' : 'da_fare';
        else if (c.stato === 'da_fare' && i >= k && !seq.slice(k, i).some((x) => !x.sosta)) c.stato = 'prossima';
      }
    }
    return { modalita: ev?.modalita || 'cartacea', scene: scene.map(({ id: scid, codice, titolo, sosta, ordine }) => ({ id: scid, codice, titolo, sosta, ordine })), squadre: squadre.map(({ numero, nome, id: sid }) => ({ id: sid, numero, nome })), celle, aggiornato: new Date().toISOString() };
}
