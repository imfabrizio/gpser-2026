-- ruolo dell'accompagnatore: segna dallo smartphone le squadre in attesa davanti alle scene
insert into ruolo (codice, nome, sistema, aree) values ('accompagnatore', 'Accompagnatore', true, '{accompagnatore}') on conflict (codice) do nothing;
