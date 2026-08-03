FROM node:22-alpine

WORKDIR /app
COPY package.json ./package.json
COPY replay.js server.js ./

ENV PORT=8789
EXPOSE 8789

CMD ["node", "server.js"]
