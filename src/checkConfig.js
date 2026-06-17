import { loadConfig } from "./config.js";

const strict = process.argv.includes("--strict");

try {
  const config = loadConfig({ requireRuntime: strict });

  console.log("Configuration is readable.");
  console.log(`Strict mode: ${strict ? "yes" : "no"}`);
  console.log(`Configured channels: ${config.channelIds.size}`);
  console.log(`Output directory: ${config.outputDir}`);
  console.log(`Storage: ${config.storage}`);
  console.log(`SQL enabled: ${config.useSql ? "yes" : "no"}`);
  console.log(`Webhook enabled: ${config.useWebhook ? "yes" : "no"}`);
  console.log(`Ignore bot messages: ${config.ignoreBots ? "yes" : "no"}`);
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}
