-- Il ruolo generico «Istruttore» era un'impostazione iniziale sbagliata: chi lo aveva passa a «Istruttore DU» (stessi permessi)
update utente set ruolo = 'istruttore_du' where ruolo = 'istruttore';
insert into utente_ruolo_extra select utente_id, 'istruttore_du' from utente_ruolo_extra where ruolo = 'istruttore' on conflict do nothing;
delete from utente_ruolo_extra where ruolo = 'istruttore';
delete from ruolo where codice = 'istruttore';
