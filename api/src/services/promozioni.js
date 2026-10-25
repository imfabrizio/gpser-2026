// Promozione di scene e schede alla libreria regionale/nazionale: proposta → approvazione (o automatica per la direzione).
import { httpErr } from './compilazioni.js';
import { haSchede } from '../libreria-ambito.js';

const slug = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function proponi(db, utente, scenaId, { tipo, livello, nota }) {
  if (!['scena', 'schede'].includes(tipo)) throw httpErr(400, 'scegli se promuovere la scena intera o solo le schede');
  if (!['regionale', 'nazionale'].includes(livello)) throw httpErr(400, 'scegli il livello: regionale o nazionale');
  const { rows: [s] } = await db.query('select s.id, (select count(*) from scena_scheda x where x.scena_id=s.id and not x.is_master)::int as schede from scena s where s.id=$1', [scenaId]);
  if (!s) throw httpErr(404, 'scena inesistente');
  if (!s.schede) throw httpErr(400, 'la scena non ha schede da promuovere');
  if ((await db.query(`select 1 from promozione where scena_id=$1 and stato='in_attesa'`, [scenaId])).rowCount) throw httpErr(409, 'c\'è già una proposta in attesa per questa scena');
  const auto = haSchede(utente);
  const { rows: [p] } = await db.query(
    `insert into promozione (scena_id, tipo, livello, automatica, proposta_da, nota) values ($1,$2,$3,$4,$5,nullif(trim($6),'')) returning *`,
    [scenaId, tipo, livello, auto, utente.id, nota ?? '']);
  return auto ? approva(db, p.id, utente.id) : p;
}

// confronta le voci di una scheda di scena con quelle di una patologia (testo, sezione, SEP)
async function stesseVoci(db, schedaId, patologiaId) {
  const a = (await db.query('select sezione, testo, is_sep from scena_scheda_voce where scheda_id=$1 order by ordine', [schedaId])).rows;
  const b = (await db.query('select pv.sezione, v.testo, pv.is_sep from patologia_voce pv join voce v on v.id=pv.voce_id where pv.patologia_id=$1 order by pv.ordine', [patologiaId])).rows;
  return a.length === b.length && a.every((x, i) => x.sezione === b[i].sezione && x.testo === b[i].testo && x.is_sep === b[i].is_sep);
}

async function pubblicaScheda(db, k, livello, utenteId) {
  if (k.patologia_id) {
    const { rows: [pt] } = await db.query('select id, comitato from patologia where id=$1', [k.patologia_id]);
    if (pt && await stesseVoci(db, k.id, pt.id)) {
      if (pt.comitato) { await db.query('update patologia set comitato=null, livello=$2, bozza=false where id=$1', [pt.id, livello]); return { titolo: k.titolo, esito: 'pubblicata' }; }
      return { titolo: k.titolo, esito: 'già in libreria' };
    }
  }
  const base = k.patologia_id ? (await db.query('select categoria, macro, macro2, categoria2 from patologia where id=$1', [k.patologia_id])).rows[0] : null;
  let codice = `${livello === 'nazionale' ? 'NAZ' : 'REG'}-${slug(k.titolo)}`.slice(0, 60);
  for (let n = 2; (await db.query('select 1 from patologia where codice=$1', [codice])).rowCount; n++) codice = `${codice.replace(/-\d+$/, '')}-${n}`;
  const { rows: [p] } = await db.query(
    `insert into patologia (codice, nome, sigla, is_bls, is_master, is_diu, categoria, categoria2, macro, macro2, gravita, fasce, livello, creata_da)
     values ($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [codice, k.titolo, k.sigla, k.is_bls, k.is_diu, base?.categoria || k.titolo, base?.categoria2 ?? null, k.macro ?? base?.macro ?? null, base?.macro2 ?? null, k.gravita, k.fasce ? JSON.stringify(k.fasce) : null, livello, utenteId]);
  const voci = (await db.query('select * from scena_scheda_voce where scheda_id=$1 order by ordine', [k.id])).rows;
  let o = 0;
  for (const v of voci) {
    let { rows: [sc] } = await db.query(
      `select id from scala_punteggio where mb is not distinct from $1 and be is not distinct from $2 and su is not distinct from $3 and "in" is not distinct from $4 and ne is not distinct from $5 order by (codice like '%/%') limit 1`, [v.mb, v.be, v.su, v.in, v.ne]);
    if (!sc) ({ rows: [sc] } = await db.query(`insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6) on conflict (codice) do update set codice=excluded.codice returning id`,
      [`${v.mb ?? '-'}/${v.be ?? '-'}/${v.su ?? '-'}/${v.in ?? '-'}/${v.ne ?? '-'}`, v.mb, v.be, v.su, v.in, v.ne]));
    const { rows: [vc] } = await db.query(`insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo = voce.testo returning id`, [v.testo]);
    await db.query('insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,$6)', [p.id, ++o, v.sezione, vc.id, sc.id, v.is_sep]);
  }
  return { titolo: k.titolo, esito: 'creata' };
}

export async function approva(db, id, utenteId) {
  const { rows: [p] } = await db.query('select * from promozione where id=$1 for update', [id]);
  if (!p) throw httpErr(404, 'proposta inesistente');
  if (p.stato !== 'in_attesa') throw httpErr(409, 'proposta già decisa');
  const schede = (await db.query('select * from scena_scheda where scena_id=$1 and not is_master order by slot', [p.scena_id])).rows;
  const esito = [];
  for (const k of schede) esito.push(await pubblicaScheda(db, k, p.livello, utenteId));
  if (p.tipo === 'scena') await db.query('update scena set condivisa=$2 where id=$1', [p.scena_id, p.livello]);
  return (await db.query(`update promozione set stato='approvata', deciso_da=$2, deciso_il=now(), esito=$3 where id=$1 returning *`, [id, utenteId, JSON.stringify(esito)])).rows[0];
}

export async function rifiuta(db, id, utenteId, motivo) {
  const { rows: [p] } = await db.query(`update promozione set stato='rifiutata', deciso_da=$2, deciso_il=now(), motivo=nullif(trim($3),'') where id=$1 and stato='in_attesa' returning *`, [id, utenteId, motivo ?? '']);
  if (!p) throw httpErr(409, 'proposta inesistente o già decisa');
  return p;
}
