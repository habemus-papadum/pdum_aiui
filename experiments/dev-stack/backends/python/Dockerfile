FROM python:3.14-slim
WORKDIR /app
COPY backends/python ./backends/python
COPY infrastructure/ready.py ./infrastructure/ready.py
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["python", "-u", "backends/python/server.py"]
