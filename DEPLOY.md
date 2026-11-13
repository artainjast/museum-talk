# Deploy

Env: `PORT` (default 3000), `HOST_TOKEN` (guide secret; random + printed at start if unset).

```sh
docker build -t museum .
docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 -e HOST_TOKEN=change-me --name museum museum
```

nginx (inside the HTTPS `server {}` for the subdomain):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

URLs: visitors `/`, guide `/?host=<HOST_TOKEN>`, offline guide `/?solo=1`, top-down view `&flat=1`.
Health check: `/healthz`.
