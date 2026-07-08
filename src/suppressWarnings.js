// Подавляем ТОЛЬКО DEP0180 («fs.Stats constructor is deprecated») — оно приходит из
// недр discord.js/undici на Node ≥22, безвредно, но мозолит логи. Всё остальное
// (любые другие warnings/deprecations) пропускаем как обычно.
// Должен импортироваться ПЕРВЫМ (до discord.js), поэтому стоит верхней строкой index.js.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const opts = typeof args[0] === "object" && args[0] !== null ? args[0] : null;
  const code = opts ? opts.code : args[1];
  const text = typeof warning === "string" ? warning : (warning && warning.message) || "";
  if (code === "DEP0180" || /Stats constructor is deprecated/i.test(text)) return;
  return originalEmitWarning.call(process, warning, ...args);
};
