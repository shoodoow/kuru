FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    adduser \
    sudo \
    procps \
    curl \
    ca-certificates \
    git \
    build-essential \
    nodejs \
    npm \
    python3 \
    python3-pip \
    python3-venv \
    xvfb \
    x11vnc \
    novnc \
    python3-websockify \
    xdotool \
    x11-xserver-utils \
    xfonts-base \
    jwm \
    xterm \
    chromium \
    pcmanfm \
    fonts-dejavu-core \
    imagemagick \
    ffmpeg \
    socat \
    netcat-openbsd \
    iptables \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/nano
COPY browser-bridge.mjs /opt/nano/

CMD ["sleep", "infinity"]
