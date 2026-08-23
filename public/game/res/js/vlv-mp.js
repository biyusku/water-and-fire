/**
 * vlv-mp.js — VLV Multiplayer Layer for Fireboy & Watergirl
 *
 * Yükleme: public/game/index.html içine eklendi.
 * Sadece URL'de ?vlv=1 varsa aktifleşir.
 *
 * ?vlv=1&role=host&token=JWT  → Fireboy (ArrowKeys), WebRTC offer oluşturur
 * ?vlv=1&role=guest&token=JWT → Watergirl (WASD),    WebRTC offer'a cevap verir
 *
 * 20 Hz DataChannel sync: { t:"s", x, y, vx, vy, kl, kr, ku }
 */

(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  if (params.get("vlv") !== "1") return;

  const ROLE  = params.get("role");   // "host" | "guest"
  const TOKEN = params.get("token");

  if (!ROLE || !TOKEN) {
    console.warn("[VLV-MP] missing role or token");
    return;
  }

  const SYNC_MS = 50; // 20 Hz

  // WS proxy paths (same-origin, avoids mixed-content on HTTPS)
  const isHttps   = location.protocol === "https:";
  const wsScheme  = isHttps ? "wss" : "ws";
  const SIG_URL   = isHttps
    ? `${wsScheme}://${location.host}/ws-signal?token=${encodeURIComponent(TOKEN)}`
    : `ws://213.146.184.56:8080/ws?token=${encodeURIComponent(TOKEN)}`;

  const ICE = [
    { urls: "stun:213.146.184.56:3478" },
    {
      urls: [
        "turn:213.146.184.56:3478?transport=udp",
        "turn:213.146.184.56:3478?transport=tcp",
      ],
      username:   "vlv-demo",
      credential: "changeme-in-production",
    },
  ];

  const log = (...a) => console.log("[VLV-MP]", ...a);

  // ── player refs ────────────────────────────────────────────────────────────
  // allPlayers[0] = fireboy, allPlayers[1] = watergirl
  // host = fireboy = index 0, guest = watergirl = index 1

  function getMe()     { const p = window.vlvPlayers; return p && p[ROLE === "host" ? 0 : 1]; }
  function getRemote() { const p = window.vlvPlayers; return p && p[ROLE === "host" ? 1 : 0]; }

  // ── key locking ────────────────────────────────────────────────────────────
  // Set remote player's key strings to values that will never match a real
  // keydown event, so local keyboard cannot move them.

  let keyLocked = false;

  function lockRemoteKeys() {
    const remote = getRemote();
    if (!remote) return false;
    if (keyLocked) return true;
    remote.keys.up    = "__vlv_none__";
    remote.keys.left  = "__vlv_none__";
    remote.keys.right = "__vlv_none__";
    keyLocked = true;
    log("remote player keys locked ✓");
    return true;
  }

  // Poll until game has initialized allPlayers, then lock
  function pollLockKeys() {
    const t = setInterval(() => {
      if (lockRemoteKeys()) clearInterval(t);
    }, 100);
    // Give up after 10s
    setTimeout(() => clearInterval(t), 10000);
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────────

  let pc = null;
  let dc = null;
  let ws = null;
  let syncTimer = null;
  let pendingCandidates = []; // buffer ICE candidates until remote desc is set
  let remoteDescSet = false;

  function buildPC() {
    pc = new RTCPeerConnection({ iceServers: ICE });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sig({ type: "ice", candidate });
    };

    pc.onconnectionstatechange = () => {
      log("pc:", pc.connectionState);
      if (pc.connectionState === "connected") {
        notifyParent("connected");
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        notifyParent("disconnected");
        if (syncTimer) clearInterval(syncTimer);
      }
    };

    if (ROLE === "host") {
      dc = pc.createDataChannel("g", { ordered: false, maxRetransmits: 0 });
      wireChannel(dc);
    } else {
      pc.ondatachannel = ({ channel }) => {
        dc = channel;
        wireChannel(dc);
      };
    }
  }

  function wireChannel(ch) {
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      log("DataChannel open ✓");
      notifyParent("connected");
      startSync();
      // Lock keys when channel opens (game should be loaded by now)
      if (!lockRemoteKeys()) pollLockKeys();
    };
    ch.onclose   = () => { log("DataChannel closed"); notifyParent("disconnected"); };
    ch.onmessage = ({ data }) => {
      try { applyRemote(JSON.parse(data)); } catch {}
    };
  }

  async function drainCandidates() {
    for (const c of pendingCandidates) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    pendingCandidates = [];
  }

  let sigRole = null; // "offerer" | "answerer" — assigned by signaling server

  async function onSignal(m) {
    if (!pc) return;

    // Signaling server assigns WebRTC roles — use this instead of ROLE param
    if (m.type === "role") {
      sigRole = m.role; // "offerer" or "answerer"
      log("signaling role:", sigRole);
      if (sigRole === "offerer") {
        // Wait a bit for the other peer to connect, then send offer
        setTimeout(makeOffer, 600);
      }
      return;
    }

    if (m.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      remoteDescSet = true;
      await drainCandidates();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sig({ type: "answer", sdp: ans.sdp });
      log("answer sent");

    } else if (m.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      remoteDescSet = true;
      await drainCandidates();

    } else if (m.type === "ice" && m.candidate) {
      if (remoteDescSet) {
        try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {}
      } else {
        pendingCandidates.push(m.candidate);
      }
    }
  }

  async function makeOffer() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig({ type: "offer", sdp: offer.sdp });
    log("offer sent");
  }

  // ── signaling ───────────────────────────────────────────────────────────────

  let wsReady = false;
  let wsQueue = []; // buffer messages until WS is open

  function sig(payload) {
    const data = JSON.stringify(payload);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else {
      wsQueue.push(data);
    }
  }

  function openSignaling() {
    ws = new WebSocket(SIG_URL);

    ws.onopen = () => {
      log("signaling open");
      wsReady = true;
      // Flush buffered messages
      wsQueue.forEach(d => ws.send(d));
      wsQueue = [];
      // Offer is triggered by "role" message from signaling server — not here
    };

    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      log("signal rx:", m.type);
      await onSignal(m);
    };

    ws.onerror = (e) => log("signaling error", e);
    ws.onclose = () => log("signaling closed");
  }

  // ── sync ────────────────────────────────────────────────────────────────────

  function startSync() {
    syncTimer = setInterval(() => {
      if (!dc || dc.readyState !== "open") return;
      const me = getMe();
      if (!me) return;
      const k = me.keys.pressed;
      try {
        dc.send(JSON.stringify({
          t:  "s",
          x:  Math.round(me.position.x * 10) / 10,
          y:  Math.round(me.position.y * 10) / 10,
          vx: Math.round(me.velocity.x * 100) / 100,
          vy: Math.round(me.velocity.y * 100) / 100,
          kl: k.left  ? 1 : 0,
          kr: k.right ? 1 : 0,
          ku: k.up    ? 1 : 0,
        }));
      } catch {}
    }, SYNC_MS);
  }

  function applyRemote(m) {
    if (m.t !== "s") return;
    const remote = getRemote();
    if (!remote) return;
    remote.position.x       = m.x;
    remote.position.y       = m.y;
    remote.velocity.x       = m.vx;
    remote.velocity.y       = m.vy;
    remote.keys.pressed.left  = !!m.kl;
    remote.keys.pressed.right = !!m.kr;
    remote.keys.pressed.up    = !!m.ku;
    // Re-lock keys every apply in case game reset them
    if (!keyLocked) lockRemoteKeys();
  }

  // ── parent communication ────────────────────────────────────────────────────

  function notifyParent(event) {
    try { window.parent.postMessage({ vlv: event }, "*"); } catch {}
  }

  // ── boot ────────────────────────────────────────────────────────────────────

  log(`role=${ROLE} starting…`);
  pollLockKeys(); // start locking keys immediately when game loads
  buildPC();
  openSignaling();

})();