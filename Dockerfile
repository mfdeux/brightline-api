# ---- Base: Bun on Debian so we can apt-get wkhtmltopdf/unrtf ----
FROM oven/bun:debian

# Install system deps: wkhtmltopdf, unrtf, and common fonts
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    wkhtmltopdf \
    unrtf \
    fonts-dejavu \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Workdir
WORKDIR /app

# Install JS deps first (better layer caching)
COPY package.json bun.lockb* ./
RUN bun install --production

# Copy source
COPY src ./src

# Env + runtime config
ENV NODE_ENV=production
ENV PORT=3000
# If your binaries are in non-standard locations, set these. Defaults are fine on Debian.
ENV WKHTMLTOPDF_PATH=/usr/bin/wkhtmltopdf
ENV UNRTF_PATH=/usr/bin/unrtf

# Expose API port
EXPOSE 3000

# Healthcheck (optional but handy)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"ok":true' || exit 1

# Start server
CMD ["bun", "run", "src/server.ts"]
