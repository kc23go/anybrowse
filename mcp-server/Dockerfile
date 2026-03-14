FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci || npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Set default environment variables (can be overridden)
ENV ANYBROWSE_API_URL=https://anybrowse.dev
ENV NODE_ENV=production

# Run the MCP server
CMD ["node", "dist/index.js"]
