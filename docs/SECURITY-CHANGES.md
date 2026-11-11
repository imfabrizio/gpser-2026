# Correzioni di sicurezza — 26 ottobre 2026

Base: `440ece818014c2aaace8c77e3fe3696b9a9005c7`.

## Comportamenti modificati

- Il ticket MFA non è più una sessione API. Il flag `SSO_RICHIEDE_MFA=1` richiede realmente il codice agli utenti con MFA attiva; lo staff senza MFA viene indirizzato alla configurazione secondo la policy esistente.
- I codici di recupero vengono consumati atomicamente. Token malformati vengono rifiutati senza errori interni; le risposte API hanno `Cache-Control: no-store`.
- Compilazioni, riapertura, importazione Excel, duplicazione/copia scene e scrittura degli avvisi verificano l’evento anche quando l’identificatore arriva nel corpo/query. Il corpo non può sovrascrivere la scena autorizzata dalla rotta. Aggiungere una scheda richiede anche accesso alla patologia sorgente.
- Le aree per riapertura compilazioni, modifica qualifiche e comando dei turni sono esplicite.
- Microsoft: i collegamenti già presenti restano validi. Per collegare un’identità nuova a un account esistente, l’amministratore usa **Richieste → Verifica identità e collega Microsoft**, dopo una verifica indipendente della persona. Ruoli e password non vengono modificati. La corrispondenza dell’email da sola non autorizza il collegamento.

## Esami locali e inviti

La migrazione `045-esami-accesso-locale.sql` aggiunge il comitato della sessione e gli inviti nominativi. Non elimina dati.

Le sessioni associate a eventi seguono i diritti di gestione dell’evento. Per sessioni autonome o eventi storici senza ente, l’accesso locale usa il creatore/comitato. Gli amministratori hanno accesso completo. Le sessioni senza un proprietario riconoscibile restano accessibili agli amministratori.

Nella pagina della sessione, **Inviti esterni** permette di aggiungere e revocare account già registrati, attivi e abilitati all’area Esami. L’invito riguarda solo quella sessione: consente consultazione, creazione/compilazione e gestione dello stato delle prove, ma non eliminazione né gestione degli inviti. Non invia email. La revoca impedisce le successive richieste API; documenti già scaricati non possono essere richiamati.

La ricerca anagrafica negli esami è limitata al comitato della sessione, salvo amministratori. Un candidato esterno si può inserire manualmente senza collegarlo all’anagrafica globale.

## Dipendenze e compatibilità

`fast-uri` è aggiornato entro le versioni compatibili. ExcelJS resta alla stessa versione; l’override `exceljs → uuid 11.1.1` corregge l’avviso noto mantenendo l’API `v4()` utilizzata. Un test esporta e rilegge regole Excel estese che esercitano quel percorso. Rimuovere/rivalutare l’override quando ExcelJS aggiornerà la propria dipendenza.

I percorsi delle font PDF e dei test usano `fileURLToPath`, compatibile anche con Windows.

## Rilascio e ripristino

Prima del rilascio fare separatamente un backup verificato del database reale: il backup Git contiene il codice, non il database né i segreti di configurazione. Non usare mai la suite di test contro la produzione: crea/elimina database con nomi dedicati.

1. Applicare il branch/patch su una copia con la base indicata; installare con `npm ci`.
2. Provare su staging con una copia protetta del database e verificare l’assegnazione delle sessioni storiche.
3. Applicare la migrazione tramite il flusso esistente (`npm run db:init` o migrazioni automatiche all’avvio). Con `AUTO_MIGRAZIONI=0` applicarla prima di avviare il codice nuovo.
4. Verificare login password/MFA, Google, Microsoft già collegato e nuovo collegamento amministrativo; verificare invito/revoca tra due comitati.
5. Pubblicare solo dopo questi controlli sulla configurazione reale.

Il rollback del codice può usare il tag `backup/security-review-2026-10-26`; la migrazione è additiva, quindi non è necessario eliminare le nuove tabelle per tornare al codice precedente. **Il vecchio codice riapre le vulnerabilità e l’accesso globale agli esami**: preferire una correzione in avanti. Un eventuale ripristino del database richiede il backup DB separato.

Non ruotare alla cieca `JWT_SECRET`: è usato anche per cifrare MFA, codici fiscali e chiavi AI, e per indicizzare i codici fiscali con HMAC. Una rotazione richiede migrazione dei dati e conservazione protetta della vecchia chiave.

# Correzioni di sicurezza — 11 novembre 2026

Base: `4fd998d`.

- **Identificatori nell’indirizzo solo in forma canonica.** PostgreSQL accetta un UUID anche senza trattini o tra graffe; il controllo «evento di un altro ente» lavorava sul testo e lasciava passare quelle scritture, che poi il database riconosceva. Un utente dello staff poteva così leggere e modificare eventi, scene, schede e squadre di altri enti. Ora ogni parametro `:id`, `:evento`, `:pid`, `:scheda`, `:utente` che non sia un UUID canonico riceve 400, prima di qualunque altra verifica.
- **Limiti ai tentativi indipendenti dall’indirizzo.** Dietro Render `X-Forwarded-For` viene solo accodato: la prima voce la sceglie il client, quindi cambiandola a ogni richiesta i tentativi su password e codice MFA erano illimitati. Ora c’è anche un tetto per account (20 errori di password, 10 di codice ogni 15 minuti) e l’indirizzo del client si legge da `CF-Connecting-IP` quando `TRUST_PROXY=1`. Limitati anche i tentativi su disattivazione e conferma della MFA. Effetto collaterale voluto: chi conosce un’email può bloccarne l’accesso con password per 15 minuti; l’accesso con Google/Microsoft non ne risente.
- **Sincronizzazione offline.** Valutazioni e riaperture si inviano a nome di un’altra persona solo se quella persona è giudice della scheda o master della scena.
- **Intestazioni e dipendenze.** Aggiunto `Strict-Transport-Security` sulle risposte HTTPS; il workflow di backup non ha permessi sul repository; `npm audit fix` (glob, minimatch tramite `@fastify/static`).

Nessuna migrazione. I test `SEC-UUID`, `SEC-LIMITI` e `OFF-1` coprono i tre casi.

## Seconda parte — isolamento per regione, eventi, registrazione, sessioni, CSP

Migrazione `066-regioni-eventi-sicurezza.sql` (additiva: toglie un indice, aggiunge colonne; non elimina dati).

**Prima di pubblicare, su Render:**

1. `PUBLIC_URL` deve essere impostato (https, senza `/` finale): senza, **il server non parte**. L’indirizzo del sito non si ricava più dalle intestazioni della richiesta.
2. `BACKUP_PASSPHRASE`: senza, «Scarica il database» risponde con un errore invece di consegnare il dump in chiaro.
3. `RESEND_API_KEY` con un mittente su dominio verificato (`NOTIFICA_DA`): serve a spedire il codice di verifica a chi si registra con password. Il mittente di prova di Resend consegna solo al titolare dell’account. Senza posta la registrazione funziona comunque, ma la richiesta arriva marcata «email NON verificata» e per approvarla l’amministratore deve dichiarare di aver controllato la persona.
4. Ogni persona dello staff deve avere in anagrafica un comitato dell’elenco ufficiale: è da lì che si ricava la sua regione. Chi non lo ha vede solo le persone senza comitato e non può creare canovacci.

**Cosa cambia**

- **Amministratore = utenza trasversale.** Vede e modifica tutto, in tutte le regioni.
- **Anagrafica per regione.** Chi ha l’area Anagrafiche vede, modifica ed elimina solo le persone della propria regione (più quelle il cui comitato non è riconosciuto) e assegna solo comitati della propria regione. Nessuno cambia da solo il proprio comitato né le proprie qualifiche: lo fa un amministratore. L’elenco dei comitati (aggiunta, modifica, importazione, riconduzione dei nomi) è riservato agli amministratori; gli altri lo consultano.
- **Canovacci per regione.** Colonna `regione`: ognuno vede e modifica quelli della propria regione e quelli generali (senza regione: storici ed esempi). La migrazione assegna la regione ai canovacci esistenti a partire dalla gara a cui sono collegati; quelli non collegati a un evento con regione restano generali e li può assegnare un amministratore. La stessa lettera con lo stesso codice gara può esistere in regioni diverse.
- **Giudici e staff da scegliere.** Gli elenchi mostrano le persone della propria regione, quelle senza comitato e chi è già iscritto come giudice a un evento della regione.
- **Più eventi attivi insieme.** Tolto il vincolo «un solo evento attivo»: attivare un evento non ne spegne altri. Nuovo pulsante «Disattiva» (`POST /api/eventi/:id/disattiva`), registrato nel log. La pagina pubblica mostra il percorso di ogni gara in corso (filtrabile per regione, ordinabile per vicinanza); corsi, Mega Code ed esami restano non pubblici.
- **Verifica dell’email alla registrazione con password**: codice di 6 cifre valido 30 minuti, conservato solo come impronta. Con Google e Microsoft non serve.
- **Sessioni**: al cambio password (proprio o fatto dall’amministratore) tutte le sessioni precedenti decadono; chi cambia la propria riceve subito un token nuovo.
- **OTP**: un codice già usato, o di un passo precedente, non viene più accettato.
- **CSP senza script inline**: il codice delle pagine è in `web/app-*.js`, i pulsanti non hanno più `onclick`; `script-src 'self'`. Aggiunto `https://www.google.com` a `frame-src` per la mappa incorporata, che la vecchia regola bloccava.

**Non toccato, da sapere**: la ricerca persone della Segreteria (solo nome e comitato) e l’elenco dei dispositivi restano nazionali; gli stili inline restano ammessi.
