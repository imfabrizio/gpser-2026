// Ruoli in gara come compaiono sui badge e nelle liste della segreteria.
export const RUOLI_BADGE = {
  partecipante_leader: { nome: 'Capo squadra', colore: '#C8102E' },
  partecipante_membro: { nome: 'Soccorritore', colore: '#C8102E' },
  allenatore: { nome: 'Allenatore', colore: '#1F4E79' },
  accompagnatore: { nome: 'Accompagnatore', colore: '#1F4E79' },
  supporter: { nome: 'Supporter', colore: '#1F4E79' },
  giudice: { nome: 'Giudice', colore: '#2E7D32' },
  giudice_master: { nome: 'Giudice master', colore: '#1B5E20' },
  simulatore: { nome: 'Simulatore', colore: '#B45F06' },
  truccatore: { nome: 'Truccatore', colore: '#B45F06' },
  fotografo: { nome: 'Fotografo', colore: '#444444' },
  organizzazione: { nome: 'Organizzazione', colore: '#444444' },
  altro: { nome: 'Altro', colore: '#444444' },
};
export const SENZA_SQUADRA_OK = ['giudice', 'giudice_master', 'simulatore', 'truccatore', 'organizzazione', 'altro'];
