# Use Node.js base image
FROM node:20-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && echo "yt-dlp version:" && yt-dlp --version \
    && echo "ffmpeg version:" && ffmpeg -version | head -1

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create temp directory
RUN mkdir -p temp

# Expose port (Railway will set PORT env variable)
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
