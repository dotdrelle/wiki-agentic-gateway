FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 7789

ENTRYPOINT ["node", "bin/wiki-agentic-gateway.js"]
