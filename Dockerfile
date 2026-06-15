# Discord-бот ГСУ СК (dsbot) — образ для запуска на сервере.
FROM node:20-alpine

# Часовой пояс (для корректных дат в логах). При желании поменять через TZ в .env.
ENV NODE_ENV=production

WORKDIR /app

# Сначала только манифесты — кэш слоёв при неизменных зависимостях.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Затем исходники.
COPY . .

# Логи пишутся в ./logs (смонтировать томом в compose, чтобы переживали рестарт).
CMD ["npm", "start"]
