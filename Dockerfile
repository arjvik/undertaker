FROM node:alpine as build
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
RUN apk add git
COPY .git .git
COPY src src
RUN sed -e "s/{{GIT-HASH}}/$(git describe --always)/" -i src/index.ts
COPY tsconfig.json .
RUN npx tsc

FROM node:alpine
WORKDIR /app
COPY --from=build /app/build/ ./
COPY --from=build /app/node_modules/ ./node_modules/
CMD ["node", "index.js"]