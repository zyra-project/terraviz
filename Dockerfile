FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache git git-lfs

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and config
COPY tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
