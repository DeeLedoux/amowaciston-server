
# âmowaciston Jane AI server — Docker (Node 20)
FROM node:20-slim

ENV NODE_ENV=production     PORT=8787

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --only=production || npm i --production

# Copy the rest
COPY . .

# Create data dir for SQLite if used
RUN mkdir -p /app/data

EXPOSE 8787

# Healthcheck (basic)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
