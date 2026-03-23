FROM node:20-alpine

# Install Docker CLI so we can trigger sibling containers
# Install zip for auto-zipping output files when agent generates 5+ files
RUN apk add --no-cache docker-cli zip

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/api/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["node", "server.js"]
