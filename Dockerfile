FROM node:20-alpine

WORKDIR /

# Build deps for native modules (better-sqlite3)
RUN apk add --no-cache \
    python3 make g++ git

COPY package*.json ./
RUN npm ci || npm install

COPY server ./server
COPY overlay ./overlay
COPY admin ./admin

# run as non-root for puppeteer/chromium sandbox
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "server/src/index.js"]
