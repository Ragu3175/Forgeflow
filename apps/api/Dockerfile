FROM node:20-alpine

WORKDIR /app

# Copy root package.json and workspace package.json files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/

# Install dependencies across workspaces
RUN npm install

# Copy shared code and API source
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Build shared package first, then API
RUN npm run build --workspace=@forgeflow/shared
RUN npm run build --workspace=@forgeflow/api

WORKDIR /app/apps/api

EXPOSE 4000

# Execute database migrations then start the server
CMD ["sh", "-c", "npm run migrate && npm run start"]
