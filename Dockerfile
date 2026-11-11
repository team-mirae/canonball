# Runtime only: dist/ is built on the Mac (npm run build) and shipped, so the host never runs npm.
FROM node:24-alpine
RUN apk add --no-cache git tini && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY dist/ ./
ENV NODE_ENV=production NODE_NO_WARNINGS=1 \
    CANONBALL_DATA_DIR=/data CANONBALL_HOST=0.0.0.0 CANONBALL_PORT=8080
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "/app/canonball.mjs", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/canonball.mjs"]
