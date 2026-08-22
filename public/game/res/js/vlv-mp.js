/**
 * vlv-mp.js — VLV Multiplayer Layer for Fireboy & Watergirl
 *
 * Loads inside public/game/index.html when URL has ?vlv=1
 * Query params:
 *   vlv=1          — enable multiplayer
 *   role=host      — Fireboy  (ArrowKeys), creates WebRTC offer
 *   role=guest     — Watergirl (WASD),     answers WebRTC offer
 *   token=<jwt>    — VLV signaling JWT
 *
 * State sync @ 20 Hz over unreliable DataChannel (unordered, maxRetransmits=0):
 *   { t:"s", x, y, vx, vy, kl, kr, ku }
 */

(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  if (params.get("vlv") !== "1") return; // not in multiplayer mode

  const ROLE  = params.get("role");  // "host" | "guest"
  const TOKEN = params.get("token");

  if (!ROLE || !TOKEN) {
    console.warn("[VLV-MP] missing role or token — multiplayer disabled");
    return;
  }

  const SYNC_MS = 50; // 20 Hz
  // Use same-origin WS proxy when served over HTTPS (e.g. Railway)
  // to avoid mixed-content blocks. Falls back to direct WS when HTTP.
  const _sigBase = location.protocol === "https:"
    ? `wss://${location.host}/ws-signal`
    : "ws://213.146.184.56:8080/ws";
  const SIG_URL = `${_sigBase}?token=${encodeURIComponent(TOKEN)}`;

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

  // ── helpers ──────────────────────────────────────────────────────────────

  const log = (...a) => console.log("[VLV-MP]", ...a);

  /** Returns [myPlayer, remotePlayer] once game has initialised */
  function getPlayers() {
    const p = window.vlvPlayers;
    if (!p || p.length < 2) return null;
    // allPlayers[0] = fireboy, allPlayers[1] = watergirl
    return ROLE === "host" ? [p[0], p[1]] : [p[1], p[0]];
  }

  // ── signaling ─────────────────────────────────────────────────────────────

  let ws = null;
  let pc = null;
  let dc = null;
  let syncTimer = null;

  function openSignaling(cb) {
    ws = new WebSocket(SIG_URL);
    ws.onopen    = () => { log("signaling open"); cb(); };
    ws.onerror   = (e) => log("signaling error", e);
    ws.onclose   = () => log("signaling closed");
    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      await onSignal(m);
    };
  }

  function sig(payload) {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(payload));
  }

  // ── WebRTC ────────────────────────────────────────────────────────────────

  function buildPC() {
    pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = ({ candidate }) => { if (candidate) sig({ type: "ice", candidate }); };
    pc.onconnectionstatechange = () => log("pc:", pc.connectionState);

    if (ROLE === "host") {
      dc = pc.createDataChannel("g", { ordered: false, maxRetransmits: 0 });
      wireChannel(dc);
    } else {
      pc.ondatachannel = ({ channel }) => { dc = channel; wireChannel(dc); };
    }
  }

  function wireChannel(ch) {
    ch.binaryType = "arraybuffer";
    ch.onopen  = () => {
      log("DataChannel open ✓");
      notifyParent("connected");
      startSync();
      lockRemoteKeys();
    };
    ch.onclose   = () => { log("DataChannel closed"); notifyParent("disconnected"); };
    ch.onmessage = ({ data }) => {
      try { applyRemote(JSON.parse(data)); } catch {}
    };
  }

  async function onSignal(m) {
    if (!pc) return;
    if (m.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sig({ type: "answer", sdp: ans.sdp });
    } else if (m.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(m));
    } else if (m.type === "ice" && m.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {}
    }
  }

  async function makeOffer() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig({ type: "offer", sdp: offer.sdp });
  }

  // ── game sync ─────────────────────────────────────────────────────────────

  function startSync() {
    syncTimer = setInterval(() => {
      if (!dc || dc.readyState !== "open") return;
      const ps = getPlayers();
      if (!ps) return;
      const [me] = ps;
      const k = me.keys.pressed;
      dc.send(JSON.stringify({
        t:  "s",
        x:  me.position.x,
        y:  me.position.y,
        vx: me.velocity.x,
        vy: me.velocity.y,
        kl: k.left  ? 1 : 0,
        kr: k.right ? 1 : 0,
        ku: k.up    ? 1 : 0,
      }));
    }, SYNC_MS);
  }

  function applyRemote(m) {
    if (m.t !== "s") return;
    const ps = getPlayers();
    if (!ps) return;
    const [, remote] = ps;
    remote.position.x       = m.x;
    remote.position.y       = m.y;
    remote.velocity.x       = m.vx;
    remote.velocity.y       = m.vy;
    remote.keys.pressed.left  = !!m.kl;
    remote.keys.pressed.right = !!m.kr;
    remote.keys.pressed.up    = !!m.ku;
  }

  // ── key locking ───────────────────────────────────────────────────────────

  /**
   * Replace remote player's key bindings with dummy values so that
   * local keyboard events (which iterate allPlayers) never move them.
   * Only network state updates drive the remote character.
   */
  function lockRemoteKeys() {
    const ps = getPlayers();
    if (!ps) return;
    const [, remote] = ps;
    remote.keys.up    = "__none__";
    remote.keys.left  = "__none__";
    remote.keys.right = "__none__";
    log("remote player keys locked to network-only");
  }

  // ── parent frame communication ─────────────────────────────────────────────

  function notifyParent(event) {
    try { window.parent.postMessage({ vlv: event }, "*"); } catch {}
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  log(`starting as ${ROLE}…`);
  buildPC();

  openSignaling(() => {
    if (ROLE === "host") {
      setTimeout(makeOffer, 400);
    }
  });

})();