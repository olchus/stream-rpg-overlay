FROM node:20-alpine

WORKDIR /app

# build deps for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ git

COPY package*.json ./
RUN npm ci || npm install

COPY server ./server
COPY overlay ./overlay

EXPOSE 3000
CMD ["node", "server/src/index.js"]
