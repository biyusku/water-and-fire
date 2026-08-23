/**
 * Tank Battle — VLV Edition
 * Two-player maze tank game with WebRTC sync via VLV
 *
 * Controls:
 *   P1 (Red):   W/A/S/D + F to shoot
 *   P2 (Blue):  Arrow keys + L to shoot  (local fallback)
 *   In VLV online mode: each player controls their own tank only
 */

(function () {
  "use strict";

  // ── Canvas setup ─────────────────────────────────────────────────────────────
  const canvas = document.getElementById("c");
  const ctx    = canvas.getContext("2d");

  const CELL = 48;
  const COLS = 15;
  const ROWS = 11;
  const W    = CELL * COLS;
  const H    = CELL * ROWS;

  canvas.width  = W;
  canvas.height = H;

  function resize() {
    const scaleX = window.innerWidth  / W;
    const scaleY = window.innerHeight / H;
    const scale  = Math.min(scaleX, scaleY, 1.4);
    canvas.style.width  = Math.round(W * scale) + "px";
    canvas.style.height = Math.round(H * scale) + "px";
  }
  resize();
  window.addEventListener("resize", resize);

  // ── VLV / URL params ─────────────────────────────────────────────────────────
  const params  = new URLSearchParams(location.search);
  const VLV_ON  = params.get("vlv") === "1";
  const MY_ROLE = params.get("role") || null;
  const TOKEN   = params.get("token") || null;
  const MY_NAME = decodeURIComponent(params.get("name") || (MY_ROLE === "host" ? "Red" : "Blue"));
  const MY_IDX  = VLV_ON ? (MY_ROLE === "host" ? 0 : 1) : -1;

  // ── Maze generation ──────────────────────────────────────────────────────────
  let SEED = parseInt(params.get("seed") || "0") || ((Date.now() % 99991) + 1);

  function seededRand(s) {
    s = ((s * 1664525 + 1013904223) | 0) >>> 0;
    return { val: s / 0x100000000, next: s };
  }

  function generateMaze(seed) {
    const visited = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    const walls   = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => ({ right: true, bottom: true }))
    );

    let s = seed >>> 0;

    function rand4() {
      const dirs = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) {
        const r = seededRand(s); s = r.next;
        const j = Math.floor(r.val * (i + 1));
        const tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
      }
      return dirs;
    }

    function carve(r, c) {
      visited[r][c] = true;
      const DR = [-1, 0, 1, 0];
      const DC = [0, 1, 0, -1];
      for (const d of rand4()) {
        const nr = r + DR[d];
        const nc = c + DC[d];
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        if (visited[nr][nc]) continue;
        if (d === 0) walls[r - 1][c].bottom = false;
        else if (d === 1) walls[r][c].right = false;
        else if (d === 2) walls[r][c].bottom = false;
        else walls[r][c - 1].right = false;
        carve(nr, nc);
      }
    }
    carve(0, 0);
    return walls;
  }

  let walls = generateMaze(SEED);

  // ── Colors ───────────────────────────────────────────────────────────────────
  const COLORS = ["#ff6b35", "#4fc3f7"];
  const DARK   = ["#cc4400", "#0288d1"];
  const FLOOR_A = "#3e3e3e";
  const FLOOR_B = "#363636";
  const WALL_C  = "#111";

  // ── Tank constants ────────────────────────────────────────────────────────────
  const TANK_R       = 14;
  const SPEED        = 2.2;
  const TURN_SPEED   = 0.045;
  const BULLET_SPD   = 5;
  const MAX_BOUNCES  = 4;
  const SHOOT_CD_MS  = 500;

  function spawnPos(idx) {
    if (idx === 0) return { x: CELL * 1.5, y: CELL * 1.5, angle: 0 };
    return { x: CELL * (COLS - 1.5), y: CELL * (ROWS - 1.5), angle: Math.PI };
  }

  function makeTank(idx) {
    const p = spawnPos(idx);
    return { idx, x: p.x, y: p.y, angle: p.angle, alive: true, lastShot: 0,
             name: (idx === MY_IDX ? MY_NAME : (idx === 0 ? "Red" : "Blue")) };
  }

  let tanks   = [makeTank(0), makeTank(1)];
  let bullets = [];
  let scores  = [0, 0];
  let gameOver = false;

  // ── Input ─────────────────────────────────────────────────────────────────────
  const keys = {};
  window.addEventListener("keydown", e => { keys[e.code] = true; });
  window.addEventListener("keyup",   e => { keys[e.code] = false; });

  const BINDS = [
    { left: "KeyA", right: "KeyD", up: "KeyW", fire: "KeyF" },
    { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", fire: "KeyL" },
  ];

  // ── Wall collision ────────────────────────────────────────────────────────────
  function collidesWithWall(nx, ny) {
    const r = TANK_R - 3;
    for (const dx of [-r, r]) {
      for (const dy of [-r, r]) {
        const cx = nx + dx, cy = ny + dy;
        const col = Math.floor(cx / CELL);
        const row = Math.floor(cy / CELL);
        if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return true;
      }
    }
    return false;
  }

  // ── Bullet wall bounce ────────────────────────────────────────────────────────
  function moveBullet(b) {
    const nx = b.x + b.vx;
    const ny = b.y + b.vy;

    // Canvas border bounce
    if (nx < 4 || nx > W - 4) { b.vx = -b.vx; b.bounces++; }
    if (ny < 4 || ny > H - 4) { b.vy = -b.vy; b.bounces++; }

    const col = Math.floor(b.x / CELL);
    const row = Math.floor(b.y / CELL);

    if (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
      // Right wall
      if (b.vx > 0 && col < COLS - 1 && walls[row][col].right) {
        const wx = (col + 1) * CELL;
        if (b.x < wx && nx >= wx) { b.vx = -b.vx; b.bounces++; }
      }
      // Left wall
      if (b.vx < 0 && col > 0 && walls[row][col - 1].right) {
        const wx = col * CELL;
        if (b.x > wx && nx <= wx) { b.vx = -b.vx; b.bounces++; }
      }
      // Bottom wall
      if (b.vy > 0 && row < ROWS - 1 && walls[row][col].bottom) {
        const wy = (row + 1) * CELL;
        if (b.y < wy && ny >= wy) { b.vy = -b.vy; b.bounces++; }
      }
      // Top wall (bottom of row above)
      if (b.vy < 0 && row > 0 && walls[row - 1][col].bottom) {
        const wy = row * CELL;
        if (b.y > wy && ny <= wy) { b.vy = -b.vy; b.bounces++; }
      }
    }

    b.x += b.vx;
    b.y += b.vy;
  }

  // ── Shoot ─────────────────────────────────────────────────────────────────────
  function shoot(tankIdx) {
    const t = tanks[tankIdx];
    if (!t.alive) return;
    const now = Date.now();
    if (now - t.lastShot < SHOOT_CD_MS) return;
    t.lastShot = now;
    bullets.push({
      x: t.x + Math.cos(t.angle) * (TANK_R + 5),
      y: t.y + Math.sin(t.angle) * (TANK_R + 5),
      vx: Math.cos(t.angle) * BULLET_SPD,
      vy: Math.sin(t.angle) * BULLET_SPD,
      owner: tankIdx,
      bounces: 0,
    });
  }

  // ── Round reset ───────────────────────────────────────────────────────────────
  function resetRound() {
    SEED = (Math.abs(SEED * 1664525 + 1013904223) % 99991) + 1;
    walls = generateMaze(SEED);
    tanks = [makeTank(0), makeTank(1)];
    bullets = [];
    gameOver = false;
    document.getElementById("msg").style.display = "none";
  }

  // ── Update ────────────────────────────────────────────────────────────────────
  function update(now) {
    if (gameOver) return;

    tanks.forEach((t, idx) => {
      if (!t.alive) return;

      let left = false, right = false, up = false, fire = false;

      if (!VLV_ON) {
        const b = BINDS[idx];
        left  = !!keys[b.left];
        right = !!keys[b.right];
        up    = !!keys[b.up];
        fire  = !!keys[b.fire];
      } else if (idx === MY_IDX) {
        const b = BINDS[0];
        left  = !!keys[b.left];
        right = !!keys[b.right];
        up    = !!keys[b.up];
        fire  = !!keys[b.fire];
      }
      // remote tank: position applied by VLV sync below

      if (left)  t.angle -= TURN_SPEED;
      if (right) t.angle += TURN_SPEED;
      if (up) {
        const nx = t.x + Math.cos(t.angle) * SPEED;
        const ny = t.y + Math.sin(t.angle) * SPEED;
        if (!collidesWithWall(nx, ny)) { t.x = nx; t.y = ny; }
      }
      if (fire) shoot(idx);

      if (VLV_ON && idx === MY_IDX) {
        window.__vlvTankState = {
          x: t.x, y: t.y, angle: t.angle,
          fired: fire && (now - t.lastShot < 60),
        };
      }
    });

    // Move bullets, remove expired
    bullets = bullets.filter(b => b.bounces <= MAX_BOUNCES);
    bullets.forEach(b => moveBullet(b));

    // Bullet-tank collision
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
      const b = bullets[bi];
      for (let ti = 0; ti < tanks.length; ti++) {
        const t = tanks[ti];
        if (!t.alive) continue;
        const dx = b.x - t.x, dy = b.y - t.y;
        if (dx * dx + dy * dy < (TANK_R + 5) * (TANK_R + 5)) {
          t.alive = false;
          bullets.splice(bi, 1);
          const winner = 1 - ti;
          scores[winner]++;
          document.getElementById("s1").textContent = scores[0];
          document.getElementById("s2").textContent = scores[1];
          gameOver = true;
          const msg = document.getElementById("msg");
          const wName = tanks[winner] ? tanks[winner].name : (winner === 0 ? "Red" : "Blue");
          msg.textContent = wName + " wins! 🎉\nSpace / Enter → next round";
          msg.style.display = "block";
          break;
        }
      }
      if (gameOver) break;
    }
  }

  // ── Draw ──────────────────────────────────────────────────────────────────────
  function draw() {
    // Checkerboard floor
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? FLOOR_A : FLOOR_B;
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

    // Walls
    ctx.strokeStyle = WALL_C;
    ctx.lineWidth   = 4;
    ctx.lineCap     = "round";

    // Border
    ctx.strokeRect(2, 2, W - 4, H - 4);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = c * CELL, y = r * CELL;
        if (walls[r][c].right && c < COLS - 1) {
          ctx.beginPath();
          ctx.moveTo(x + CELL, y + 3);
          ctx.lineTo(x + CELL, y + CELL - 3);
          ctx.stroke();
        }
        if (walls[r][c].bottom && r < ROWS - 1) {
          ctx.beginPath();
          ctx.moveTo(x + 3,        y + CELL);
          ctx.lineTo(x + CELL - 3, y + CELL);
          ctx.stroke();
        }
      }
    }

    // Bullets
    ctx.shadowBlur = 0;
    bullets.forEach(b => {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[b.owner];
      ctx.shadowBlur  = 12;
      ctx.shadowColor = COLORS[b.owner];
      ctx.fill();
    });
    ctx.shadowBlur = 0;

    // Tanks
    tanks.forEach(t => {
      if (!t.alive) return;
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.angle);

      // Body
      ctx.fillStyle = COLORS[t.idx];
      ctx.beginPath();
      ctx.roundRect(-TANK_R, -TANK_R, TANK_R * 2, TANK_R * 2, 4);
      ctx.fill();

      // Inner panel
      ctx.fillStyle = DARK[t.idx];
      ctx.beginPath();
      ctx.roundRect(-TANK_R + 5, -TANK_R + 5, TANK_R * 2 - 10, TANK_R * 2 - 10, 2);
      ctx.fill();

      // Barrel
      ctx.fillStyle = DARK[t.idx];
      ctx.fillRect(2, -4, TANK_R + 6, 8);

      ctx.restore();

      // Name tag above tank
      ctx.font         = "bold 11px monospace";
      ctx.textAlign    = "center";
      ctx.textBaseline = "bottom";
      const tw = ctx.measureText(t.name).width + 8;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(t.x - tw / 2, t.y - TANK_R - 20, tw, 15);
      ctx.fillStyle = COLORS[t.idx];
      ctx.fillText(t.name, t.x, t.y - TANK_R - 6);
    });
  }

  // ── Main loop ─────────────────────────────────────────────────────────────────
  function loop(ts) {
    update(ts);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Restart
  window.addEventListener("keydown", e => {
    if (gameOver && (e.code === "Space" || e.code === "Enter")) resetRound();
  });

  // ── VLV Multiplayer layer ─────────────────────────────────────────────────────
  const p2pEl = document.getElementById("p2p-status");

  if (!VLV_ON) {
    p2pEl.textContent = "Local 2P: WASD+F  vs  Arrows+L";
    return;
  }

  const SIG_URL   = "wss://vlvsignal.rusk.agency/ws?token=" + encodeURIComponent(TOKEN);
  const ICE_CFG   = {
    iceServers: [
      { urls: "stun:213.146.184.56:3478" },
      { urls: ["turn:213.146.184.56:3478?transport=udp",
               "turn:213.146.184.56:3478?transport=tcp"],
        username: "vlv-demo", credential: "changeme-in-production" },
    ],
  };
  const REMOTE_IDX = MY_IDX === 0 ? 1 : 0;

  let pc = null, dc = null, sigWs = null;
  let sigRole = null, remoteDescSet = false, pendingICE = [];
  let wsQueue = [], syncTimer = null;

  function notifyParent(ev) {
    try { window.parent.postMessage({ vlv: ev }, "*"); } catch {}
  }

  function buildPC() {
    pc = new RTCPeerConnection(ICE_CFG);
    pc.onicecandidate = ({ candidate }) => { if (candidate) sig({ type: "ice", candidate }); };
    pc.ondatachannel  = ({ channel }) => { dc = channel; wireChannel(dc); };
    pc.onconnectionstatechange = () => {
      p2pEl.textContent = "P2P: " + pc.connectionState;
      if (pc.connectionState === "connected")   notifyParent("connected");
      if (pc.connectionState === "failed" ||
          pc.connectionState === "disconnected") notifyParent("disconnected");
    };
  }

  function wireChannel(ch) {
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      p2pEl.textContent = "P2P: connected ✓";
      notifyParent("connected");
      try { ch.send(JSON.stringify({ t: "name", name: MY_NAME })); } catch {}
      syncTimer = setInterval(() => {
        if (!dc || dc.readyState !== "open") return;
        const s = window.__vlvTankState;
        if (!s) return;
        try {
          dc.send(JSON.stringify({
            t: "s",
            x: Math.round(s.x * 10) / 10,
            y: Math.round(s.y * 10) / 10,
            a: Math.round(s.angle * 1000) / 1000,
            f: s.fired ? 1 : 0,
          }));
        } catch {}
      }, 50);
    };
    ch.onclose   = () => notifyParent("disconnected");
    ch.onmessage = ({ data }) => { try { applyRemote(JSON.parse(data)); } catch {} };
  }

  function applyRemote(m) {
    if (m.t === "name") { tanks[REMOTE_IDX].name = m.name; return; }
    if (m.t !== "s") return;
    const rt = tanks[REMOTE_IDX];
    rt.x     = m.x;
    rt.y     = m.y;
    rt.angle = m.a;
    if (m.f) shoot(REMOTE_IDX);
  }

  function sig(payload) {
    const d = JSON.stringify(payload);
    if (sigWs && sigWs.readyState === WebSocket.OPEN) sigWs.send(d);
    else wsQueue.push(d);
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
      if (sigRole === "offerer") {
        dc = pc.createDataChannel("t", { ordered: false, maxRetransmits: 0 });
        wireChannel(dc);
        setTimeout(async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sig({ type: "offer", sdp: offer.sdp });
        }, 600);
      }
      return;
    }
    if (m.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      remoteDescSet = true; await drainICE();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sig({ type: "answer", sdp: ans.sdp });
    } else if (m.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(m));
      remoteDescSet = true; await drainICE();
    } else if (m.type === "ice" && m.candidate) {
      if (remoteDescSet) {
        try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {}
      } else {
        pendingICE.push(m.candidate);
      }
    }
  }

  function openSignaling() {
    sigWs = new WebSocket(SIG_URL);
    sigWs.onopen = () => { wsQueue.forEach(d => sigWs.send(d)); wsQueue = []; };
    sigWs.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      await onSignal(m);
    };
    sigWs.onerror = () => { p2pEl.textContent = "Signaling error"; };
  }

  buildPC();
  openSignaling();

})();