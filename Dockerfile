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

# 在线升级（设置 → 系统升级）会先在 /app 下写 .upgrade-tmp-* 再 rename。
# 镜像里的 /app 默认归 root，而 compose 常用非 root 用户运行（如
# user: "1000:1001"），不 chown 就会 EACCES。node 固定 uid=1000，属主
# 有写权限即可，gid 不同不影响。
RUN chown -R node:node /app

VOLUME ["/data"]
EXPOSE 9621

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9621)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "server/index.js"]
