# Textbook - standalone image.
#
#   docker build -t textbook .
#   docker run -d --name textbook -p 9621:9621 \
#     -v "$PWD/data:/data" -v "/path/to/books:/books" textbook
#
# node:24 already ships node:sqlite; the package launcher adds
# --experimental-sqlite so the same command also works on Node 22.5+.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=9621 \
    TEXTBOOK_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY web/dist ./web/dist
COPY README.md LICENSE ./

VOLUME ["/data"]
EXPOSE 9621

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9621)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "server/index.js"]
