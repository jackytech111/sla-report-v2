FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY . .
RUN chmod +x entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["start"]
