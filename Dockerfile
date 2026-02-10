FROM node:20-alpine

WORKDIR /

# build deps for native modules (better-sqlite3) + chromium for kick-js (puppeteer)
RUN apk add --no-cache \
    python3 make g++ git \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont \
  && if [ -x /usr/bin/chromium-browser ] && [ ! -x /usr/bin/chromium ]; then ln -s /usr/bin/chromium-browser /usr/bin/chromium; fi \
  && if [ -x /usr/bin/chromium ] && [ ! -x /usr/bin/chromium-browser ]; then ln -s /usr/bin/chromium /usr/bin/chromium-browser; fi

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm ci || npm install

COPY server ./server
COPY overlay ./overlay

# run as non-root for puppeteer/chromium sandbox
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "server/src/index.js"]
