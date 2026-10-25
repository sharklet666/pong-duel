# 双人乒乓球 · 容器镜像
#
# 为什么需要 Dockerfile：
#   Render 免费套餐要求绑卡，所以改用 Koyeb / Zeabur / Hugging Face Spaces 这类
#   不需要信用卡的平台。这些平台普遍用容器方式部署。
#
# 这个项目没有第三方依赖（零 npm 包），所以镜像很小、启动很快。

FROM node:22-alpine

# 安全：以非 root 用户运行
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# 只复制运行需要的东西。
# 注意排除 bin/（52MB 的 cloudflared，部署后完全用不到）。
COPY --chown=app:app package.json ./
COPY --chown=app:app server.mjs ./
COPY --chown=app:app index.html ./
COPY --chown=app:app style.css ./
COPY --chown=app:app js ./js

USER app

# 平台会注入 PORT（Koyeb/HF/Zeabur 都是）。
# 我们默认 8080，万一没注入也不会崩。
ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 8080

# 健康检查用 Node 内置，不依赖 curl（alpine 里没有）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
