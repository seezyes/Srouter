docker stop srouter
docker rm srouter
docker build -t srouter .
docker run -d --name srouter -p 20127:20127 --env-file .env -v srouter-data:/app/data srouter