FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js wateringCircuitMode.js zigbeeIdentity.js ./
CMD ["node", "server.js"]
