FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN chmod +x entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["start"]
