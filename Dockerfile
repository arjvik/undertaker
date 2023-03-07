FROM node:alpine as build
RUN apk add python3 make g++ git
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY .git .git
COPY src src
RUN sed -e "s/{{GIT-HASH}}/$(git describe --always)/" -i src/peer.ts
COPY tsconfig.json .
RUN npm install typescript
RUN npx tsc

FROM rust:alpine as rust_build
WORKDIR /app
COPY rust_hasher .
RUN --mount=type=cache,target=/usr/local/cargo/registry cargo build --release

FROM node:alpine
WORKDIR /app
COPY --from=build /app/dist/ ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=rust_build /app/target/release/hasher ./hasher
CMD ["node", "index.js"]