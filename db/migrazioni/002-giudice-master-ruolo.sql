-- nuovo ruolo: giudice master (comandante della scena). Da solo in questo file: un nuovo valore di enum non si usa nella stessa transazione.
alter type ruolo_utente add value if not exists 'giudice_master';
