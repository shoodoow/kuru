# Node comes from the official image: Debian's own package is version 18, and current tools need 22.
FROM node:22-bookworm-slim AS node

FROM debian:bookworm-slim

# poppler-utils (pdftotext, pdftoppm) and python3-pypdf: agents read PDFs people upload;
# without them a payslip upload failed on a missing module and pip refused to install one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    adduser \
    sudo \
    procps \
    curl \
    ca-certificates \
    git \
    build-essential \
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
    poppler-utils \
    python3-pypdf \
  && rm -rf /var/lib/apt/lists/*

# node, npm and npx. Yarn's files are left behind: nothing here uses it.
COPY --from=node /usr/local/bin/node /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# The browser tools: agent-browser drives the Chromium above over its debugging port.
# Chromium comes from Debian, so agent-browser's own browser download is not run.
# The version is fixed, the same one as AGENT_BROWSER_VERSION in src/linux/linux.ts: left open, npm picks a
# much older release on this Node, and that one misses clicks on a scrolled page.
RUN npm install -g agent-browser@0.39.1 && agent-browser --version

CMD ["sleep", "infinity"]
