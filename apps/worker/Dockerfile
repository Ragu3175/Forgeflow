FROM node:20-alpine

WORKDIR /app

# Copy root package.json and workspace package.json files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/worker/package*.json ./apps/worker/

# Install dependencies across workspaces
RUN npm install

# Copy shared code and Worker source
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

# Build shared package first, then worker
RUN npm run build --workspace=@forgeflow/shared
RUN npm run build --workspace=@forgeflow/worker

WORKDIR /app/apps/worker

EXPOSE 9102

# Start the worker process
CMD ["npm", "run", "start"]

