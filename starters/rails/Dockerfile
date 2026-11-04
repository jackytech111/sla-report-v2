# Build stage: compiles native gem extensions (puma, nio4r, ...).
FROM ruby:3.3-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libyaml-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install --jobs 4 \
 && rm -rf /usr/local/bundle/cache "${GEM_HOME:-/usr/local/bundle}"/ruby/*/cache

# Runtime stage: no compilers.
FROM ruby:3.3-slim
WORKDIR /app
ENV RAILS_ENV=production
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY . .
RUN chmod +x entrypoint.sh bin/rails && mkdir -p tmp log
EXPOSE 8080
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["start"]
