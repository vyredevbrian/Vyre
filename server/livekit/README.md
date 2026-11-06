# LiveKit voice chat on this server

One command installs LiveKit next to your sites: it opens the firewall ports, starts LiveKit in Docker, puts it on its own address behind the existing HTTPS proxy (Caddy), and creates the API key and secret.

## 1. Point a name at the server (once)

At your DNS provider (GoDaddy for stagwifhood.fun) add an A record: name `lk`, value `147.182.171.109`, TTL 600. Wait a few minutes.
The installer refuses to run until this is right (a wrong name makes Let's Encrypt block the address for an hour).

## 2. Install

Connect: `ssh -i $env:USERPROFILE\.ssh\vyre_deploy root@147.182.171.109`, then, inside the session:
```
cd /opt/vyre && git pull
LK_DOMAIN=lk.stagwifhood.fun bash server/livekit/install.sh
```
It prints, once: the `wss://` URL, the server's public IP, and the API key and secret. Copy the secret into your app's server settings (never into code that runs in the browser).
It is safe to run again: it keeps the same key and secret. Run it a second time a few minutes after the first: that is when it can switch on TURN-over-TLS, because it needs the certificate Caddy makes for the name.
Read the key later (as root): `cat /opt/livekit/keys`.

## What it sets up

- Firewall (`ufw`): TCP 7881, UDP 7882, UDP 3478, TCP 5349. Docker also publishes these four ports itself (that goes around `ufw`). DigitalOcean's own cloud firewall: none is attached to this server, so nothing to open there. If you add one later it must allow the same four ports plus 22, 80 and 443.
- LiveKit (`livekit/livekit-server`, one container, 1 GB memory limit) with `rtc: tcp_port 7881, udp_port 7882, use_external_ip true`. Signalling is on port 7880 inside the container.
- Caddy routes `https://lk.stagwifhood.fun` to port 7880. WebSocket upgrades pass through on their own.
- TURN: UDP 3478 and TLS 5349, using the certificate Caddy made for the same name. It helps people on strict networks.
- Files: `/opt/livekit/` (`livekit.yaml`, `keys`, `compose.yml`), all root-only.

## 3. Check it from outside

From your own computer (Python 3):
```
python3 check-from-outside.py lk.stagwifhood.fun 147.182.171.109
```
(the file is in this folder, or save it from the repo). It checks DNS, HTTPS, the WebSocket path, TCP 7881, and the TURN ports. It needs the four required checks to pass.
**UDP 7882 cannot be proven by a script**: LiveKit does not answer a plain probe, so silence looks the same as blocked. The real test is a call: open https://livekit.io/connection-test, enter `wss://lk.stagwifhood.fun` and a token for your key (see below); it reports whether UDP works.

## Your app talks to it with a token

Your web app's server (not the browser) uses the API key and secret to make a short-lived token for each person, for example with the `livekit-server-sdk` package: create an `AccessToken(apiKey, apiSecret, { identity })`, add a grant `{ roomJoin: true, room: 'name' }`, and return `await token.toJwt()`. The browser connects with `wss://lk.stagwifhood.fun` and that token.

## Operating

- Logs: `docker logs --tail 50 livekit-livekit-1`. Restart: `docker restart livekit-livekit-1`.
- Update LiveKit: `cd /opt/livekit && docker compose -p livekit -f compose.yml --env-file .env pull && bash /opt/vyre/server/livekit/install.sh` (with `LK_DOMAIN` set). The image is `latest`; once it works, set `LK_IMAGE` to a fixed version so updates are on your terms.
- The certificate renews itself in Caddy, but LiveKit reads it only at start: restart LiveKit about every two months, or after Caddy renews (TURN over TLS only).
- Test the installer without a server: `bash server/livekit/test-install.sh`.
