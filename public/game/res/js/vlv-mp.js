/**
 * vlv-mp.js — VLV Multiplayer Layer for Fireboy & Watergirl
 *
 * Activated by URL params when loaded inside game iframe:
 *   ?vlv=1&role=host|guest&token=JWT&name=PlayerName
 *
 * Features:
 *   - WebRTC DataChannel @ 20 Hz position sync
 *   - Minecraft-style name tags above characters
 *   - Key stuck fix (window blur / tab switch)
 *   - ICE candidate buffering
 *   - Signaling role-based offer/answer
 */

(function () {
  "use strict";

  const params  = new URLSearchParams(location.search);
  if (params.get("vlv") !== "1") return;

  const ROLE     = params.get("role");   // "host" | "guest"
  const TOKEN    = params.get("token");
  const MY_NAME  = decodeURIComponent(params.get("name") || (ROLE === "host" ? "Fireboy" : "Watergirl"));

  if (!ROLE || !TOKEN) { console.warn("[VLV-MP] missing params"); return; }

  const SYNC_MS  = 50;  // 20 Hz
  // Connect via nginx WSS proxy on port 443 (self-signed, bypass mixed content)
  // wss://IP works from HTTPS pages; nginx proxies to ws://127.0.0.1:8080
  const SIG_URL = `wss://vlvsignal.rusk.agency/ws?token=${encodeURIComponent(TOKEN)}`;

  const ICE_CFG = {
    iceServers: [
      { urls: "stun:213.146.184.56:3478" },
      {
        urls: [
          "turn:213.146.184.56:3478?transport=udp",
          "turn:213.146.184.56:3478?transport=tcp",
        ],
        username:   "vlv-demo",
        credential: "changeme-in-production",
      },
    ],
    iceCandidatePoolSize: 4,
  };

  const log = (...a) => console.log("[VLV-MP]", ...a);

  // ── player refs ─────────────────────────────────────────────────────────────
  function getMe()     { const p = window.vlvPlayers; return p && p[ROLE === "host" ? 0 : 1]; }
  function getRemote() { const p = window.vlvPlayers; return p && p[ROLE === "host" ? 1 : 0]; }

  // ── name tags (Minecraft style) ─────────────────────────────────────────────
  let remoteName = ROLE === "host" ? "Watergirl" : "Fireboy";
  let canvas = null;
  let ctx    = null;

  function getCtx() {
    if (ctx) return ctx;
    canvas = document.getElementById("canvas");
    if (canvas) ctx = canvas.getContext("2d");
    return ctx;
  }

  function drawNameTag(context, name, x, y, color) {
    const PAD  = 6;
    const H    = 20;
    context.save();
    context.font         = "bold 12px Arial, sans-serif";
    context.textAlign    = "center";
    context.textBaseline = "middle";
    const w = context.measureText(name).width + PAD * 2;
    const bx = x - w / 2;
    const by = y - H / 2;

    // Dark background (semi-transparent black, like Minecraft)
    context.fillStyle = "rgba(0,0,0,0.65)";
    context.fillRect(bx, by, w, H);

    // Colored text
    context.fillStyle = color;
    context.fillText(name, x, y);
    context.restore();
  }

  // Sprite width ~40px, height ~56px — center X, draw above head
  const SPRITE_W = 40;
  const ABOVE    = 75;  // px above top of sprite

  function drawNames() {
    const c = getCtx();
    if (!c) return;
    const me     = getMe();
    const remote = getRemote();
    if (!me || !remote) return;

    const myColor  = ROLE === "host" ? "#ff8c60" : "#60c8ff";
    const remColor = ROLE === "host" ? "#60c8ff" : "#ff8c60";

    drawNameTag(c, MY_NAME,    me.position.x     + SPRITE_W / 2, me.position.y     - ABOVE, myColor);
    drawNameTag(c, remoteName, remote.position.x + SPRITE_W / 2, remote.position.y - ABOVE, remColor);
  }

  function startNameLoop() {
    // Hook into the game's own rAF — patch requestAnimationFrame so name tags
    // are drawn at the END of each game frame, after the game has already drawn.
    const _raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return _raf(function (ts) {
        cb(ts);
        drawNames();  // draw on top, every frame, after game renders
      });
    };
  }

  // ── key locking ─────────────────────────────────────────────────────────────
  let keyLocked = false;

  function lockRemoteKeys() {
    const r = getRemote();
    if (!r) return false;
    if (keyLocked) return true;
    r.keys.up    = "__vlv_none__";
    r.keys.left  = "__vlv_none__";
    r.keys.right = "__vlv_none__";
    keyLocked = true;
    log("remote keys locked ✓");
    return true;
  }

  function pollLockKeys() {
    const t = setInterval(() => { if (lockRemoteKeys()) clearInterval(t); }, 100);
    setTimeout(() => clearInterval(t), 15000);
  }

  // ── key stuck fix ─────────────────────────────────────────────────────────
  function releaseMyKeys() {
    const me = getMe();
    if (!me) return;
    for (const k in me.keys.pressed) me.keys.pressed[k] = false;
  }

  window.addEventListener("blur",             releaseMyKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseMyKeys(); });

  // ── WebRTC ─────────────────────────────────────────────────────────────────
  let pc = null, dc = null, ws = null;
  let syncTimer = null;
  let sigRole   = null;
  let pendingICE = [];
  let remoteDescSet = false;

  function buildPC() {
    pc = new RTCPeerConnection(ICE_CFG);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sig({ type: "ice", candidate });
    };

    pc.onicegatheringstatechange = () => log("ice gathering:", pc.iceGatheringState);
    pc.oniceconnectionstatechange = () => {
      log("ice:", pc.iceConnectionState);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        notifyParent("connected");
      }
    };

    pc.onconnectionstatechange = () => {
      log("pc:", pc.connectionState);
      if (pc.connectionState === "connected")  notifyParent("connected");
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        notifyParent("disconnected");
        if (syncTimer) clearInterval(syncTimer);
      }
    };

    // DataChannel is created by the offerer (sigRole), not by lobby role.
    // We always set ondatachannel in case we end up as answerer.
    pc.ondatachannel = ({ channel }) => { dc = channel; wireChannel(dc); };
  }

  function setupDataChannel() {
    // Called after sigRole is known and we are offerer
    dc = pc.createDataChannel("g", { ordered: false, maxRetransmits: 0 });
    wireChannel(dc);
  }

  function wireChannel(ch) {
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      log("DataChannel open ✓");
      notifyParent("connected");
      startSync();
      if (!lockRemoteKeys()) pollLockKeys();
      // Send our name
      try { ch.send(JSON.stringify({ t: "name", name: MY_NAME })); } catch {}
    };
    ch.onclose   = () => notifyParent("disconnected");
    ch.onmessage = ({ data }) => { try { applyRemote(JSON.parse(data)); } catch {} };
  }

  async function drainICE() {
    for (const c of pendingICE) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    pendingICE = [];
  }

  async function onSignal(m) {
    if (!pc) return;

    if (m.type === "role") {
      sigRole = m.role;
      log("sig role:", sigRole);
      if (sigRole === "offerer") {
        // Offerer creates DataChannel then makes offer
        setupDataChannel();
        setTimeout(makeOffer, 800);
      }
      return;
    }

    if (m.type === "offer") {
      log("received offer");
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      remoteDescSet = true;
      await drainICE();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sig({ type: "answer", sdp: ans.sdp });
      log("answer sent");

    } else if (m.type === "answer") {
      log("received answer");
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      remoteDescSet = true;
      await drainICE();

    } else if (m.type === "ice" && m.candidate) {
      if (remoteDescSet) {
        try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {}
      } else {
        pendingICE.push(m.candidate);
      }
    }
  }

  async function makeOffer() {
    log("creating offer…");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig({ type: "offer", sdp: offer.sdp });
    log("offer sent");
  }

  // ── signaling ────────────────────────────────────────────────────────────────
  let wsQueue = [];

  function sig(payload) {
    const d = JSON.stringify(payload);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
    else wsQueue.push(d);
  }

  function openSignaling() {
    log("connecting signaling:", SIG_URL);
    ws = new WebSocket(SIG_URL);
    ws.onopen = () => {
      log("signaling open");
      wsQueue.forEach(d => ws.send(d));
      wsQueue = [];
    };
    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      await onSignal(m);
    };
    ws.onerror = (e) => log("signaling error", e);
    ws.onclose = (e) => log("signaling closed", e.code, e.reason);
  }

  // ── game sync ────────────────────────────────────────────────────────────────
  function startSync() {
    syncTimer = setInterval(() => {
      if (!dc || dc.readyState !== "open") return;
      const me = getMe();
      if (!me) return;
      const k = me.keys.pressed;
      try {
        dc.send(JSON.stringify({
          t: "s",
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
    if (m.t === "name") {
      remoteName = m.name;
      log("remote name:", remoteName);
      return;
    }
    if (m.t === "ui") {
      log("host ui action:", m.action, m);
      if (m.action === "level") {
        // Host selected a level from main menu
        const setCurrentLevel = window.setCurrentLevel;
        const startGame       = window.startGame;
        const animation       = window.animation;
        const setMenuActive   = window.setMenuActive;
        if (setCurrentLevel) setCurrentLevel(m.index);
        if (setMenuActive)   setMenuActive(null);
        if (startGame)       startGame();
        if (animation)       animation();
      } else if (m.action === "button") {
        // Host clicked a menu button
        const btns = window.menuButtons;
        if (!btns || !btns[m.menu] || !btns[m.menu][m.btn]) return;
        const btn = btns[m.menu][m.btn];
        btn.run();
        if (m.endGame) {
          const setEndGame  = window.setEndGame;
          const startGame   = window.startGame;
          const animation   = window.animation;
          if (setEndGame)  setEndGame(false);
          if (startGame)   startGame();
          if (animation)   animation();
        }
        if (m.menu !== "mainMenu") {
          const setMenuActive = window.setMenuActive;
          if (setMenuActive) setMenuActive(null);
        }
      }
      return;
    }
    if (m.t !== "s") return;
    const r = getRemote();
    if (!r) return;
    r.position.x       = m.x;
    r.position.y       = m.y;
    r.velocity.x       = m.vx;
    r.velocity.y       = m.vy;
    r.keys.pressed.left  = !!m.kl;
    r.keys.pressed.right = !!m.kr;
    r.keys.pressed.up    = !!m.ku;
    if (!keyLocked) lockRemoteKeys();
  }

  // ── parent comm ──────────────────────────────────────────────────────────────
  function notifyParent(ev) {
    try { window.parent.postMessage({ vlv: ev }, "*"); } catch {}
  }

  // ── host UI sync (host → guest) ───────────────────────────────────────────────
  function hookHostUI() {
    if (ROLE !== "host") return;

    // Wait for canvas + game globals to be ready
    const interval = setInterval(() => {
      const canvas = window.canvas || document.querySelector("canvas");
      if (!canvas || !window.menuButtons) return;
      clearInterval(interval);

      const origMouseUp = canvas.onmouseup;
      canvas.onmouseup = function (event) {
        // Run the original handler first
        if (origMouseUp) origMouseUp.call(canvas, event);

        // Then mirror to guest via DataChannel
        if (!dc || dc.readyState !== "open") return;

        const menuActive  = window.menuActive;
        const menuLevels  = window.menuLevels;
        const menuButtons = window.menuButtons;
        const getMousePos = window.getMousePos;
        const checkMenuDiamondsCollision = window.checkMenuDiamondsCollision;
        const checkButtonCollision       = window.checkButtonCollision;
        const endGame = window.endGame;

        if (!getMousePos) return;
        const mousePos = getMousePos(event);

        // Level selection from main menu
        if (menuActive === "mainMenu" && menuLevels && checkMenuDiamondsCollision) {
          for (const index in menuLevels) {
            if (checkMenuDiamondsCollision(mousePos, menuLevels[index])) {
              sendUI({ action: "level", index });
              return;
            }
          }
        }

        // Menu button click
        if (menuActive && menuButtons && menuButtons[menuActive] && checkButtonCollision) {
          for (const btn in menuButtons[menuActive]) {
            if (checkButtonCollision(mousePos, menuButtons[menuActive][btn])) {
              setTimeout(() => {
                sendUI({ action: "button", menu: menuActive, btn, endGame: !!endGame });
              }, 210); // slightly after game's own 200ms delay
              return;
            }
          }
        }
      };
      log("host UI hook active ✓");
    }, 300);
  }

  function sendUI(payload) {
    if (!dc || dc.readyState !== "open") return;
    try { dc.send(JSON.stringify({ t: "ui", ...payload })); } catch {}
  }

  // Also expose game globals guest needs (game.js sets them on window already)
  // setCurrentLevel, setMenuActive, startGame, animation, menuButtons, endGame

  // ── boot ─────────────────────────────────────────────────────────────────────
  log(`role=${ROLE} name="${MY_NAME}" booting…`);
  pollLockKeys();
  buildPC();
  openSignaling();
  startNameLoop();
  hookHostUI();

})();