FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js energy.js storage.js registry.js zigbee.js zigbee-observer.js delivery.js ./
CMD ["node", "server.js"]
