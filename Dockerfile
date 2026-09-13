FROM node:20-alpine

WORKDIR /app

# 先复制依赖清单（本项目零依赖，这步保留以兼容未来加包）
COPY package.json ./

# 复制全部代码（含演示数据 data/db.json）
COPY . .

# 容器内非 root 运行更安全
USER node

# 平台通过 PORT 环境变量注入端口，server.js 已兼容（process.env.PORT || 3000）
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
