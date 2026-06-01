FROM node:22-alpine

WORKDIR /app
COPY server.js ./server.js
COPY public ./public

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
