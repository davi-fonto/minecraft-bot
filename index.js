// Polyfill ReadableStream for Node < 18 (used by undici)
try {
  const ws = require('web-streams-polyfill/ponyfill');
  if (typeof global.ReadableStream === 'undefined' && ws.ReadableStream) global.ReadableStream = ws.ReadableStream;
  if (typeof global.WritableStream === 'undefined' && ws.WritableStream) global.WritableStream = ws.WritableStream;
  if (typeof global.TransformStream === 'undefined' && ws.TransformStream) global.TransformStream = ws.TransformStream;
} catch (e) {
  // ignore if not installed yet
}
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const path = require('path');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || null;
const UPDATE_SECONDS = parseInt(process.env.STATUS_UPDATE_SECONDS || '10', 10);

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], partials: [Partials.Channel] });

// map messageId -> interval
const monitoringMap = new Map();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash command (per-guild if GUILD_ID provided)
  const data = [{
    name: 'monitor',
    description: 'Inizia a monitorare un server Minecraft via IP',
    options: [{
      name: 'ip',
      description: 'Indirizzo IP o host:porta del server (es. example.com o example.com:25565)',
      type: 3, // STRING
      required: true
    }]
  }];

  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) {
      await guild.commands.set(data);
      console.log('Registered guild command');
    }
  } else {
    await client.application.commands.set(data);
    console.log('Registered global command');
  }
});

async function fetchStatus(host) {
  // First try local Python mcstatus helper for speed
  try {
    const script = path.join(__dirname, 'mcstatus_query.py');
    const pythonCandidates = ['python3', 'python'];
    let out = null;
    for (const py of pythonCandidates) {
      out = await new Promise((resolve) => {
        execFile(py, [script, host], { timeout: 4000 }, (err, stdout, stderr) => {
          if (err) return resolve({ error: 'exec_error', _py: py, _stderr: stderr?.toString?.() });
          try {
            const parsed = JSON.parse(stdout);
            return resolve(Object.assign(parsed, { _py: py }));
          } catch (e) {
            return resolve({ error: 'parse_error', _py: py });
          }
        });
      });
      if (out && !out.error) break; // success
    }
    if (out && out.error) {
      console.debug(`mcstatus helper failed (${out._py}):`, out.error, out._stderr || '');
      // fallthrough to API
    } else if (out && out.online === false) {
      return { online: false };
    } else if (out && out.online === true) {
      let iconBuffer = null;
      if (out.favicon) {
        const base = out.favicon.split(',')[1] || out.favicon;
        try { iconBuffer = Buffer.from(base, 'base64'); } catch (e) { iconBuffer = null; }
      }
      return { online: true, players: out.players || 0, maxPlayers: out.maxPlayers || 0, motd: out.motd || '', iconBuffer };
    }
    // if we reach here, python helper was not usable
    console.debug('mcstatus helper not available; falling back to public API');
  } catch (e) {
    console.debug('Error invoking mcstatus helper:', e && e.message);
    // ignore and fallback
  }

  // Fallback to public API mcsrvstat.us for status
  try {
    const [hostPart, portPart] = host.split(':');
    const port = portPart ? portPart : '';
    const queryHost = port ? `${hostPart}:${port}` : hostPart;
    const url = `https://api.mcsrvstat.us/2/${encodeURIComponent(queryHost)}`;
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return { online: false };
    const data = await resp.json();
    if (!data || data.online !== true) return { online: false };
    const motd = (data.motd && (data.motd.clean && data.motd.clean.join('\n')) ) || (data.motd && data.motd.raw && data.motd.raw.join('\n')) || '';
    const players = data.players && (data.players.online ?? (data.players.list ? data.players.list.length : 0)) || 0;
    const maxPlayers = data.players && (data.players.max ?? 0) || 0;
    let iconBuffer = null;
    if (data.icon) {
      // data.icon is data:image/png;base64,<base64>
      const base = data.icon.split(',')[1] || data.icon;
      try { iconBuffer = Buffer.from(base, 'base64'); } catch (e) { iconBuffer = null; }
    }
    return { online: true, players, maxPlayers, motd, description: data.hostname || data.name || '', iconBuffer };
  } catch (err) {
    return { online: false };
  }
}

function buildEmbed(ip, info) {
  let color = 0x999999; // default grey
  let statusText = ':red_circle:Offline :x:';
  if (info.online) {
    const motd = (info.motd || '').toLowerCase();
    const isMaintenance = motd.includes('manutenzione') || motd.includes('maintenance');
    if (isMaintenance) {
      color = 0x55b4ff; // azzurro
      statusText = ':blue_circle:Manutenzione :warning:';
    } else {
      color = 0x22c55e; // verde
      statusText = ':green_circle:Online :white_check_mark:';
    }
  } else {
    color = 0xff4d4f; // rosso
    statusText = ':red_circle:Offline :x:';
  }

  const embed = new EmbedBuilder()
    .setTitle('Server Minecraft Monitor')
    .setColor(color)
    .addFields(
      { name: 'IP', value: `
${ip}
`, inline: true },
      { name: 'Giocatori', value: info.online ? `${info.players}/${info.maxPlayers}` : 'N/A', inline: true },
      { name: 'Stato', value: statusText, inline: false }
    )
    .setTimestamp();

  // MOTD will be shown as an attached image, not as embed description
  if (info.iconBuffer) embed.setThumbnail('attachment://servericon.png');
  return embed;
}


function renderMotdToSvg(motd) {
  // Convert minecraft color codes (§) to simple HTML spans with inline colors in SVG.
  // This is a lightweight renderer and supports common color codes.
  const colorMap = {
    '0':'#000000','1':'#0000AA','2':'#00AA00','3':'#00AAAA','4':'#AA0000','5':'#AA00AA','6':'#FFAA00','7':'#AAAAAA',
    '8':'#555555','9':'#5555FF','a':'#55FF55','b':'#55FFFF','c':'#FF5555','d':'#FF55FF','e':'#FFFF55','f':'#FFFFFF'
  };
  let parts = [];
  let currentColor = '#FFFFFF';
  let currentText = '';
  for (let i=0;i<motd.length;i++){
    const ch = motd[i];
    if (ch === '§' && i+1 < motd.length) {
      // push current
      if (currentText) parts.push({ text: currentText, color: currentColor });
      currentText = '';
      const code = motd[i+1].toLowerCase();
      i++; // skip code
      if (colorMap[code]) {
        currentColor = colorMap[code];
      } else if (code === 'r') {
        currentColor = '#FFFFFF';
      } else {
        // ignore other formatting for now
      }
    } else {
      currentText += ch;
    }
  }
  if (currentText) parts.push({ text: currentText, color: currentColor });

  // create simple SVG with lines
  const lineHeight = 22;
  const padding = 8;
  const lines = parts.reduce((acc, p) => {
    // split by newline
    const segs = p.text.split('\n');
    segs.forEach((s, idx) => {
      if (!acc[idx]) acc[idx] = [];
      acc[idx].push({ text: s, color: p.color });
    });
    return acc.concat([]) || acc;
  }, []);
  // fallback: treat whole text as single line
  const allText = parts.map(p=>p.text).join('');
  const svgWidth = Math.min(800, Math.max(200, allText.length * 8 + padding*2));
  const svgHeight = lineHeight + padding*2;
  // render as single line composed of spans
  let x = padding;
  let svgText = '';
  parts.forEach(p => {
    const escaped = p.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    svgText += `<tspan fill="${p.color}" x="${x}" dy="0">${escaped}</tspan>`;
    x += Math.max(8, escaped.length * 8);
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">\n  <rect width="100%" height="100%" fill="#0f172a" rx="6"/>\n  <text x="${padding}" y="${padding + 16}" font-family="Arial, sans-serif" font-size="14">${svgText}</text>\n</svg>`;
  return Buffer.from(svg);
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'monitor') {
        const member = interaction.member;
        const hasAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
        if (!hasAdmin) {
          return interaction.reply({ content: 'Solo gli amministratori possono usare questo comando.', ephemeral: true });
        }

        const ip = interaction.options.getString('ip');
        await interaction.deferReply();

          const stopButton = new ButtonBuilder().setCustomId('stop_monitor').setLabel('Stop').setStyle(ButtonStyle.Danger);
          const restartButton = new ButtonBuilder().setCustomId('restart_monitor').setLabel('Restart').setStyle(ButtonStyle.Success).setDisabled(true);
          const row = new ActionRowBuilder().addComponents(stopButton, restartButton);

          // Initial render: attempt to get icon and motd attachments
          const files = [];
          let iconAttachment = null;
          let motdAttachment = null;
          const initialInfo = await fetchStatus(ip);
          if (initialInfo.iconBuffer) {
            iconAttachment = new AttachmentBuilder(initialInfo.iconBuffer, { name: 'servericon.png' });
            files.push(iconAttachment);
          }
          // render motd image
          if (initialInfo.motd) {
            const motdSvg = renderMotdToSvg(initialInfo.motd);
            if (sharp) {
              const motdPng = await sharp(motdSvg).png().toBuffer();
              motdAttachment = new AttachmentBuilder(motdPng, { name: 'motd.png' });
            } else {
              motdAttachment = new AttachmentBuilder(motdSvg, { name: 'motd.svg' });
            }
            files.push(motdAttachment);
          }

          // set attachment-based thumbnail/image references before sending
          const initialEmbed = buildEmbed(ip, initialInfo);
          if (initialInfo.iconBuffer) initialEmbed.setThumbnail('attachment://servericon.png');
          if (initialInfo.motd) {
            if (sharp) initialEmbed.setImage('attachment://motd.png'); else initialEmbed.setImage('attachment://motd.svg');
          }
          const message = await interaction.followUp({ embeds: [initialEmbed], components: [row], files });

          const entry = { interval: null, ownerId: interaction.user.id, message, ip, stopped: false };

          const interval = setInterval(async () => {
            if (entry.stopped) return;
            const info = await fetchStatus(ip);
            const embed = buildEmbed(ip, info);
            const editFiles = [];
            if (info.iconBuffer) {
              editFiles.push(new AttachmentBuilder(info.iconBuffer, { name: 'servericon.png' }));
              embed.setThumbnail('attachment://servericon.png');
            }
            if (info.motd) {
              const motdSvg = renderMotdToSvg(info.motd);
              if (sharp) {
                const motdPng = await sharp(motdSvg).png().toBuffer();
                editFiles.push(new AttachmentBuilder(motdPng, { name: 'motd.png' }));
                embed.setImage('attachment://motd.png');
              } else {
                editFiles.push(new AttachmentBuilder(motdSvg, { name: 'motd.svg' }));
                embed.setImage('attachment://motd.svg');
              }
            }
            try {
              await message.edit({ embeds: [embed], components: [row], files: editFiles.length ? editFiles : undefined });
            } catch (err) {
              console.error('Failed to edit message, stopping updates', err);
              entry.stopped = true;
              clearInterval(interval);
              // enable restart button
              const disabledStop = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('stop_monitor').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(true),
                new ButtonBuilder().setCustomId('restart_monitor').setLabel('Restart').setStyle(ButtonStyle.Success).setDisabled(false)
              );
              try { await message.edit({ components: [disabledStop] }); } catch (_) {}
            }
          }, Math.max(5, UPDATE_SECONDS) * 1000);

          entry.interval = interval;
          monitoringMap.set(message.id, entry);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'stop_monitor') {
        const member = interaction.member;
        const hasAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
        if (!hasAdmin) return interaction.reply({ content: 'Solo gli amministratori possono fermare il monitor.', ephemeral: true });

        const messageId = interaction.message.id;
        const entry = monitoringMap.get(messageId);
        if (!entry) return interaction.reply({ content: 'Monitor non trovato o già fermato.', ephemeral: true });

        try { if (entry.interval) clearInterval(entry.interval); } catch (e) {}
        entry.stopped = true;
        entry.interval = null;

        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('stop_monitor').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(true),
          new ButtonBuilder().setCustomId('restart_monitor').setLabel('Restart').setStyle(ButtonStyle.Success).setDisabled(false)
        );
        try {
          await entry.message.edit({ components: [disabledRow] });
        } catch (e) {
          // ignore
        }
        return interaction.reply({ content: `Monitor per ${entry.ip} fermato.`, ephemeral: true });
      }

      if (interaction.customId === 'restart_monitor') {
        const member = interaction.member;
        const hasAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
        if (!hasAdmin) return interaction.reply({ content: 'Solo gli amministratori possono riavviare il monitor.', ephemeral: true });

        const messageId = interaction.message.id;
        const entry = monitoringMap.get(messageId);
        if (!entry) return interaction.reply({ content: 'Monitor non trovato.', ephemeral: true });
        if (!entry.stopped) return interaction.reply({ content: 'Il monitor è già attivo.', ephemeral: true });

        // prepare buttons
        const stopButton = new ButtonBuilder().setCustomId('stop_monitor').setLabel('Stop').setStyle(ButtonStyle.Danger);
        const restartButton = new ButtonBuilder().setCustomId('restart_monitor').setLabel('Restart').setStyle(ButtonStyle.Success).setDisabled(true);
        const row = new ActionRowBuilder().addComponents(stopButton, restartButton);

        // immediate update
        try {
          const info = await fetchStatus(entry.ip);
          const embed = buildEmbed(entry.ip, info);
          const editFiles = [];
          if (info.iconBuffer) editFiles.push(new AttachmentBuilder(info.iconBuffer, { name: 'servericon.png' }));
          if (info.motd) {
            const motdSvg = renderMotdToSvg(info.motd);
            if (sharp) {
              const motdPng = await sharp(motdSvg).png().toBuffer();
              editFiles.push(new AttachmentBuilder(motdPng, { name: 'motd.png' }));
            } else {
              editFiles.push(new AttachmentBuilder(motdSvg, { name: 'motd.svg' }));
            }
          }
          await entry.message.edit({ embeds: [embed], components: [row], files: editFiles.length ? editFiles : undefined });
        } catch (e) {
          // ignore
        }

        entry.stopped = false;
        const interval = setInterval(async () => {
          if (entry.stopped) return;
          const info = await fetchStatus(entry.ip);
          const embed = buildEmbed(entry.ip, info);
          const editFiles = [];
          if (info.iconBuffer) {
            editFiles.push(new AttachmentBuilder(info.iconBuffer, { name: 'servericon.png' }));
            embed.setThumbnail('attachment://servericon.png');
          }
          if (info.motd) {
            const motdSvg = renderMotdToSvg(info.motd);
            if (sharp) {
              // convert to png
              const motdPng = await sharp(motdSvg).png().toBuffer();
              editFiles.push(new AttachmentBuilder(motdPng, { name: 'motd.png' }));
              embed.setImage('attachment://motd.png');
            } else {
              editFiles.push(new AttachmentBuilder(motdSvg, { name: 'motd.svg' }));
              embed.setImage('attachment://motd.svg');
            }
          }
          try {
            await entry.message.edit({ embeds: [embed], components: [row], files: editFiles.length ? editFiles : undefined });
          } catch (e) {
            console.error('Failed to edit on restart tick', e);
            entry.stopped = true;
            clearInterval(interval);
          }
        }, Math.max(5, UPDATE_SECONDS) * 1000);
        entry.interval = interval;
        return interaction.reply({ content: `Monitor per ${entry.ip} riavviato.`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
  }
});

client.login(TOKEN);

async function shutdown(signal) {
  console.log(`Ricevuto ${signal}, chiusura in corso...`);
  for (const [id, entry] of monitoringMap.entries()) {
    try { clearInterval(entry.interval); } catch (e) {}
    monitoringMap.delete(id);
  }
  try {
    if (client) await client.destroy();
    console.log('Client Discord distrutto.');
  } catch (e) {
    console.error('Errore durante la distruzione del client:', e);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
