# Use Node.js 18 LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

# Expose port (default)
EXPOSE 3000

# Health check respects dynamic PORT (default 3000)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD sh -c "curl -fsS http://localhost:${PORT:-3000}/health || exit 1"

# Start the application
CMD ["npm", "start"]