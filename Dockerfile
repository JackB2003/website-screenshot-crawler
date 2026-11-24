# Playwright's image ships Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Run as the unprivileged user the base image provides.
RUN mkdir -p /app/screenshots && chown -R pwuser:pwuser /app/screenshots
USER pwuser

ENV HOST=0.0.0.0 \
    PORT=3012 \
    CHROMIUM_SANDBOX=false \
    ALLOW_UNAUTHENTICATED=true

EXPOSE 3012
CMD ["node", "server.js"]
