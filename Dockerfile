FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV NPM_CONFIG_LOGLEVEL=warn
ENV MALLOC_ARENA_MAX=2
ENV MALLOC_TRIM_THRESHOLD_=131072

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

EXPOSE 8000

CMD ["npm", "start"]
