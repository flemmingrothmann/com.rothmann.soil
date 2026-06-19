FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./server.js

ENV PORT=8788
EXPOSE 8788

CMD ["node", "server.js"]
