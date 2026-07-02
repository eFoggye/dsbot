import { loadConfig } from "./config.js";

const strict = process.argv.includes("--strict");

try {
  const config = loadConfig({ requireRuntime: strict });

  console.log("Configuration is readable.");
  console.log(`Strict mode: ${strict ? "yes" : "no"}`);
  console.log(`Configured channels: ${config.channelIds.size}`);
  console.log(`Output directory: ${config.outputDir}`);
  console.log(`Storage: ${config.storage}`);
  console.log(`API enabled: ${config.useApi ? "yes" : "no"}`);
  console.log(`Bot API URL: ${config.botApiUrl || "(не задан)"}`);
  console.log(`Guild members intent: ${config.enableGuildMembersIntent ? "yes" : "no"}`);
  console.log(`Ignore bot messages: ${config.ignoreBots ? "yes" : "no"}`);
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}
