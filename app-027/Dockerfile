# ---------- 构建阶段 ----------
FROM node:20-alpine AS build

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码与本地资源（纹样库 / 字体随镜像打包，断网可用）
COPY . .

RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine AS runtime

# 只拷 dist/ 与 nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]