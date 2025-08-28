# Minecraft Monitor Bot

Bot Discord che monitora lo stato di un server Minecraft dato l'IP e aggiorna un embed in tempo reale.

Setup rapido

1. Copia `.env.example` in `.env` e imposta `DISCORD_TOKEN` con il token del tuo bot.
2. (Opzionale) imposta `GUILD_ID` per limitare i comandi a un server specifico.
3. Installa le dipendenze: `npm install`.
4. Avvia il bot: `npm start`.

Uso

- Usa il comando `/monitor ip: <indirizzo>` per creare un embed che si aggiorna costantemente.
- Il bot aggiornerà l'embed ogni `STATUS_UPDATE_SECONDS` secondi (default 10).

Note

- Il bot usa `minecraft-server-util` per interrogare lo stato del server.
- Un server è considerato in manutenzione se il motd contiene le parole "manutenzione" o "maintenance" (case-insensitive).
