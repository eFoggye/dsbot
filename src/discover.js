/**
 * Разведка сервера (запускать ОДИН РАЗ, когда бот уже добавлен на боевой сервер):
 *   npm run discover
 *
 * Выводит:
 *   - кастомные эмодзи (имя + готовая вставка <:name:id>) — для погон и значков ролей;
 *   - роли (имя + id) — для роли «Прокуратура» и ролей должностей;
 *   - список участников (ник) — сверить, что ник == ФИО в таблице.
 *
 * Результат печатается в консоль и сохраняется в logs/discover.txt.
 * Затем впиши нужные ID в src/publish/publishConfig.js (RANK_EMOJI, POSITION_ROLE_IDS,
 * PROSECUTOR_ROLE_ID) и/или в .env.
 */
import fs from "node:fs";
import path from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config = loadConfig({ requireRuntime: true });
const logger = createLogger(config.logLevel);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, async (ready) => {
  const lines = [];
  const out = (s) => { lines.push(s); console.log(s); };

  for (const guild of ready.guilds.cache.values()) {
    out(`\n======== СЕРВЕР: ${guild.name} (${guild.id}) ========`);

    out("\n--- КАСТОМНЫЕ ЭМОДЗИ (имя → вставка) ---");
    const emojis = await guild.emojis.fetch().catch(() => null);
    if (emojis) {
      for (const e of emojis.values()) {
        out(`  ${e.name}: ${e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`}`);
      }
    }

    out("\n--- РОЛИ (имя → id) ---");
    const roles = await guild.roles.fetch().catch(() => null);
    if (roles) {
      for (const r of roles.values()) out(`  "${r.name}" → ${r.id}`);
    }

    out("\n--- УЧАСТНИКИ (ник — сверь с ФИО в таблице) ---");
    const members = await guild.members.fetch().catch((e) => { out(`  (не удалось: ${e.message} — включи Server Members Intent)`); return null; });
    if (members) {
      for (const m of members.values()) {
        if (!m.user.bot) out(`  ${m.displayName}`);
      }
    }
  }

  try {
    const file = path.resolve(config.outputDir, "discover.txt");
    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n"), "utf-8");
    logger.info("Разведка сохранена", { file });
  } catch (e) {
    logger.warn("Не удалось сохранить файл разведки", { error: e.message });
  }
  client.destroy();
  process.exit(0);
});

client.on(Events.Error, (e) => logger.error("Discord error", { error: e.message }));
await client.login(config.token);
