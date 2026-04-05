FROM node:20-bookworm-slim

WORKDIR /app

# System dependencies for Tauri development (build + WebKitGTK)
# Reference: https://v2.tauri.app/start/prerequisites/#linux
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    git-lfs \
    bash \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Tauri CLI
RUN cargo install tauri-cli --locked

# Install Node dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and config
COPY tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
