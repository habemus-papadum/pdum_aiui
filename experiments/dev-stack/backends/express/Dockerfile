FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backends/express ./backends/express
COPY infrastructure/ready.mjs ./infrastructure/ready.mjs
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "backends/express/server.mjs"]
