FROM node:20-alpine

WORKDIR /app
COPY server/package*.json ./
RUN npm i

COPY server ./server
COPY overlay ./overlay

WORKDIR /app/server
# jeśli używasz TS — dodaj tsc + build; jeśli JS — pomiń
RUN npm i -D typescript && npx tsc --init && npm run build || true

EXPOSE 3000
CMD ["node", "dist/index.js"]
