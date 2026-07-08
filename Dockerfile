FROM node:20-slim

# Use Google Chrome Stable rather than Debian's chromium package: the latter
# (currently v150) SIGTRAPs on launch inside a container. Chrome Stable is the
# most battle-tested headless browser for Docker and pulls its own deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        google-chrome-stable \
        fonts-liberation \
        fonts-ipafont-gothic \
        fonts-freefont-ttf \
        fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chrome (don't let Puppeteer download its own).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY miruro.js ./

EXPOSE 3232

CMD ["node", "server.js"]
