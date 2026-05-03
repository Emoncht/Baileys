# Use Node 20 alpine for a small image size
FROM node:20-alpine

# Install dependencies needed for Baileys/Node
RUN apk add --no-cache ffmpeg python3 make g++ 

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY . .

# Build the TypeScript code
RUN npm run build

# Expose the port (matches your .env)
EXPOSE 3500

# Start the application
CMD ["npm", "start"]
