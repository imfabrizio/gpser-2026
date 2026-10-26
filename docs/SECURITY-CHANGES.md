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
