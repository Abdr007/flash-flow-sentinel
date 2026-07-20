# FLASH FLOW SENTINEL — always-on daemon (persistent host)
# node:22 = stable global WebSocket → enables ~1s accountSubscribe push capture
FROM node:22-slim

WORKDIR /app

# deps first (layer cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# app
COPY sentinel.js verify.cjs ./
COPY lib ./lib
COPY index.html app.js styles.css flash-trade-v2.png favicon.png ./

# state dir (ephemeral — the daemon rebuilds the window from chain on boot)
RUN mkdir -p data

ENV NODE_ENV=production
# platform injects PORT; sentinel.js binds 0.0.0.0 when PORT is set
EXPOSE 4646

CMD ["node", "sentinel.js"]
