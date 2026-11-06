#!/usr/bin/env python3
"""Checks a LiveKit server from the outside (run it from your own computer or anywhere that is not the server).
Usage: python3 check-from-outside.py lk.example.com 203.0.113.10
Uses only the Python standard library."""
import os, socket, ssl, struct, sys, http.client

if len(sys.argv) != 3:
    sys.exit(__doc__)
domain, ip = sys.argv[1], sys.argv[2]
results = []  # (label, status, detail, required)
def add(label, ok, detail, required=True, info=False):
    results.append((label, "INFO" if info else ("PASS" if ok else "FAIL"), detail, required))

def stun_request():
    txid = os.urandom(12)
    return struct.pack("!HHI12s", 0x0001, 0, 0x2112A442, txid), txid

# 1. DNS
try:
    got = sorted({a[4][0] for a in socket.getaddrinfo(domain, 443, socket.AF_INET)})
    add("DNS " + domain, got == [ip], f"resolves to {', '.join(got)}")
except Exception as e:
    add("DNS " + domain, False, f"does not resolve ({e.__class__.__name__})")

# 2. HTTPS through the proxy reaches LiveKit (its root page answers OK)
try:
    c = http.client.HTTPSConnection(domain, 443, timeout=8, context=ssl.create_default_context())
    c.request("GET", "/"); r = c.getresponse(); body = r.read(100).decode("utf-8", "replace").strip()
    add("HTTPS https://%s/" % domain, r.status == 200 and body == "OK", f"status {r.status}, body {body[:30]!r}")
except Exception as e:
    add("HTTPS https://%s/" % domain, False, f"{e.__class__.__name__}: {e}")

# 3. WebSocket upgrade path (no token, so LiveKit must answer 401: that proves the WebSocket request reaches it)
try:
    s = socket.create_connection((domain, 443), timeout=8)
    s = ssl.create_default_context().wrap_socket(s, server_hostname=domain); s.settimeout(8)
    s.sendall((f"GET /rtc HTTP/1.1\r\nHost: {domain}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
               "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").encode())
    line = s.recv(200).split(b"\r\n")[0].decode("utf-8", "replace"); s.close()
    add("WebSocket upgrade /rtc", " 401" in line, f"answered {line!r} (401 = reached LiveKit, no token)")
except Exception as e:
    add("WebSocket upgrade /rtc", False, f"{e.__class__.__name__}: {e}")

# 4. WebRTC over TCP
try:
    socket.create_connection((ip, 7881), timeout=6).close()
    add("TCP 7881 (WebRTC over TCP)", True, "connected")
except Exception as e:
    add("TCP 7881 (WebRTC over TCP)", False, f"{e.__class__.__name__}: not reachable")

# 5. TURN over UDP answers a STUN request
try:
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.settimeout(5)
    pkt, txid = stun_request(); u.sendto(pkt, (ip, 3478)); data = u.recvfrom(2048)[0]
    ok = len(data) >= 20 and struct.unpack("!H", data[:2])[0] == 0x0101 and data[8:20] == txid
    add("UDP 3478 (TURN)", ok, "answered a STUN request" if ok else "answered, but not a STUN reply", required=False)
except Exception as e:
    add("UDP 3478 (TURN)", False, "no answer (TURN off, or UDP 3478 blocked)", required=False)

# 6. TURN over TLS presents a good certificate
try:
    s = socket.create_connection((ip, 5349), timeout=6)
    s = ssl.create_default_context().wrap_socket(s, server_hostname=domain)
    add("TCP 5349 (TURN over TLS)", True, "TLS handshake ok, certificate valid for " + domain, required=False); s.close()
except Exception as e:
    add("TCP 5349 (TURN over TLS)", False, f"{e.__class__.__name__}: not reachable or certificate not valid", required=False)

# 7. UDP 7882: LiveKit stays silent to a plain STUN request, so silence proves nothing.
try:
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.settimeout(3); u.connect((ip, 7882)); u.send(stun_request()[0])
    try: u.recv(2048); detail = "got a reply"
    except socket.timeout: detail = "no reply (normal for LiveKit; this cannot tell open from blocked)"
    except ConnectionRefusedError: detail = "connection refused: the server answered 'nothing listens here' (the path is open, LiveKit is not running)"
    add("UDP 7882 (WebRTC media)", True, detail + ". Confirm with a real call: https://livekit.io/connection-test", required=False, info=True)
except Exception as e:
    add("UDP 7882 (WebRTC media)", True, f"could not send ({e.__class__.__name__})", required=False, info=True)

w = max(len(r[0]) for r in results)
for label, status, detail, required in results:
    print(f"{status:5} {label:{w}}  {detail}{'' if required else '   (optional)'}")
failed = [r for r in results if r[1] == "FAIL" and r[3]]
print("\n" + ("All required checks passed." if not failed else f"{len(failed)} required check(s) failed."))
sys.exit(1 if failed else 0)
