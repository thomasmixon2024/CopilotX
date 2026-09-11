FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./
COPY config ./config
COPY src ./src
COPY container ./container

# The pipeline core (src/core/pipeline.js) and all container modules are
# dependency-free; no npm install is required.

ENTRYPOINT ["node", "container/runtime.js"]
CMD ["--help"]
