const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function serializeMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " [unserializable meta]";
  }
}

export function createLogger(levelName = "info") {
  const minLevel = levels[levelName] ?? levels.info;

  function write(levelNameForLine, message, meta = {}) {
    if ((levels[levelNameForLine] ?? levels.info) < minLevel) {
      return;
    }

    const line = `${new Date().toISOString()} ${levelNameForLine.toUpperCase()} ${message}${serializeMeta(meta)}`;

    if (levelNameForLine === "error") {
      console.error(line);
      return;
    }

    if (levelNameForLine === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
