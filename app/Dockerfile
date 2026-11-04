# Zero runtime dependencies: TypeScript runs through Node's built-in type stripping (Node >= 22.18).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN chmod +x entrypoint.sh \
 && node -e "if(!process.features.typescript){console.error('Node '+process.version+' lacks type stripping');process.exit(1)}"
EXPOSE 8080
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["start"]
