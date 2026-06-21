# Public deployment runbook

This setup serves `https://tools.dlskr.com` through Cloudflare Tunnel in WSL and a protected gateway on Windows.

## URLs

- Public app: `https://tools.dlskr.com`
- Windows gateway: `http://127.0.0.1:8090`
- Frontend dev server: `http://127.0.0.1:4300`
- Backend API: `http://127.0.0.1:3000`

## Credentials

Edit:

```text
E:\pdf-review-workbench\.public-gateway.env
```

Example:

```env
PUBLIC_GATEWAY_USER=reviewer
PUBLIC_GATEWAY_PASS=change-this-password
PUBLIC_GATEWAY_PORT=8090
```

After changing credentials, restart the Windows stack.

## Restart after code changes or password changes

Run in Windows PowerShell:

```powershell
cd E:\pdf-review-workbench
powershell.exe -ExecutionPolicy Bypass -File .\scripts\restart-all-public.ps1
```

Or double-click/run:

```powershell
E:\pdf-review-workbench\restart-public.bat
```

The script restarts the Windows backend, frontend, protected gateway, then tries to restart `cloudflared` through WSL. If WSL is not reachable from that PowerShell session, run this manually in WSL:

```bash
sudo systemctl restart cloudflared
curl -I https://tools.dlskr.com
```

Expected result:

```text
HTTP/2 401
```

`401` is correct because the gateway requires login.

## Restart after Windows reboot

1. Open PowerShell:

```powershell
cd E:\pdf-review-workbench
powershell.exe -ExecutionPolicy Bypass -File .\scripts\restart-all-public.ps1
```

2. If the script says WSL is unavailable, open WSL:

```bash
sudo systemctl restart cloudflared
curl -I https://tools.dlskr.com
```

3. Open browser:

```text
https://tools.dlskr.com
```

## Required Cloudflare config in WSL

File:

```bash
/etc/cloudflared/config.yml
```

Content:

```yaml
tunnel: d8762425-dec6-49b5-b6f7-feafc54a162e
credentials-file: /home/diva/.cloudflared/d8762425-dec6-49b5-b6f7-feafc54a162e.json

ingress:
  - hostname: tools.dlskr.com
    service: http://172.24.240.1:8090
  - service: http_status:404
```

## Troubleshooting

Check Windows services:

```powershell
netstat -ano | findstr ":3000 :4300 :8090"
curl.exe -I http://127.0.0.1:8090
```

Check WSL can reach Windows gateway:

```bash
curl -I http://172.24.240.1:8090
```

Expected:

```text
HTTP/1.1 401 Unauthorized
```

Check Cloudflare service:

```bash
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 80 --no-pager -l
```

Meaning of common errors:

- `HTTP/2 401`: working, login required.
- `502 Bad Gateway`: tunnel is up, but origin app/gateway failed.
- `1033`: tunnel is not connected to Cloudflare.
