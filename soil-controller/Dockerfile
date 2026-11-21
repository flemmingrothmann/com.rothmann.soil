FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js wateringCircuitMode.js wateringAdmin.js zigbeeIdentity.js soilProvisioning.js soilNames.js haCategories.js haDeviceRegistry.js ./
CMD ["node", "server.js"]
