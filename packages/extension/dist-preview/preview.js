"use strict";
(() => {
  // src/avatar.ts
  var PALETTE = [
    ["#22e0a1", "#4f8cff"],
    ["#9b6bff", "#4f8cff"],
    ["#ff7a45", "#ff4d6d"],
    ["#22e0a1", "#9b6bff"],
    ["#ffb020", "#ff7a45"],
    ["#4f8cff", "#22e0a1"],
    ["#ff4d6d", "#9b6bff"],
    ["#36c8ff", "#22e0a1"]
  ];
  function hash(s) {
    let h = 0;
    for (let i2 = 0; i2 < s.length; i2++) h = h * 31 + s.charCodeAt(i2) | 0;
    return Math.abs(h);
  }
  function avatarColors(handle) {
    return PALETTE[hash(handle) % PALETTE.length];
  }
  function makeAvatar(handle, size = 24) {
    const [a, b] = avatarColors(handle);
    const node = document.createElement("div");
    node.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,${a},${b});display:flex;align-items:center;justify-content:center;flex:none;color:#08121f;font-weight:800;font-size:${Math.round(size * 0.46)}px;`;
    node.textContent = (handle.trim()[0] ?? "?").toUpperCase();
    return node;
  }

  // src/panel.ts
  var REJECT_TEXT = {
    INSUFFICIENT_BALANCE: ["Not enough balance \u2014 add funds", "error"],
    BID_TOO_LOW: ["Too low \u2014 try the suggested bid", "error"],
    ALREADY_LEADING: ["You're already winning \u{1F525}", "leading"],
    AUCTION_ENDED: ["Auction has ended", "info"],
    AUCTION_NOT_FOUND: ["Auction not found", "error"],
    RATE_LIMITED: ["Slow down \u2014 too many bids", "error"]
  };
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function pulse(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }
  function countUp(node, from, to, finalText) {
    const n = node;
    if (n._cuRaf) cancelAnimationFrame(n._cuRaf);
    const decimals = finalText.split(".")[1]?.length ?? 0;
    const dur = 480;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = `$${(from + (to - from) * eased).toFixed(decimals)}`;
      if (p < 1) {
        n._cuRaf = requestAnimationFrame(step);
      } else {
        node.textContent = `$${finalText}`;
        n._cuRaf = void 0;
      }
    };
    n._cuRaf = requestAnimationFrame(step);
  }
  function spawnRipple(btn, ev) {
    const r = btn.getBoundingClientRect();
    const d = Math.max(r.width, r.height);
    const ink = document.createElement("span");
    ink.className = "ripple";
    ink.style.width = ink.style.height = `${d}px`;
    ink.style.left = `${ev.clientX - r.left - d / 2}px`;
    ink.style.top = `${ev.clientY - r.top - d / 2}px`;
    btn.append(ink);
    window.setTimeout(() => ink.remove(), 600);
  }
  function spawnBidBurst(btn, amountText) {
    const burst = document.createElement("span");
    burst.className = "bidburst";
    burst.textContent = `+$${amountText}`;
    btn.append(burst);
    window.setTimeout(() => burst.remove(), 850);
  }
  function makeSparks(canvas) {
    const ctx = canvas.getContext("2d");
    const parts = [];
    const COLORS = ["#ffffff", "#ffe27a", "#ffb020", "#ff7a45"];
    let raf = 0;
    let running = false;
    let fill = 1;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
      h = canvas.clientHeight || 40;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };
    const frame = () => {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      if (running) {
        const x = Math.max(2, Math.min(w - 2, fill * w));
        const y = h - 2;
        const n = 2 + (Math.random() * 3 | 0);
        for (let i2 = 0; i2 < n; i2++) {
          parts.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 2.4,
            vy: -(1.4 + Math.random() * 3),
            g: 0.06 + Math.random() * 0.05,
            life: 1,
            s: 0.7 + Math.random() * 1.6,
            c: COLORS[Math.random() * COLORS.length | 0]
          });
        }
      }
      for (const p of parts) {
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.035;
        if (p.life <= 0) continue;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i2 = parts.length - 1; i2 >= 0; i2--) if (parts[i2].life <= 0) parts.splice(i2, 1);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      raf = running || parts.length ? requestAnimationFrame(frame) : 0;
    };
    return {
      setFill(frac) {
        fill = Math.max(0, Math.min(1, frac));
      },
      start() {
        if (!w) resize();
        if (!running) {
          running = true;
          if (!raf) raf = requestAnimationFrame(frame);
        }
      },
      stop() {
        running = false;
      },
      destroy() {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      }
    };
  }
  function createPanel(handlers) {
    const root = el("div", "panel");
    const head = el("div", "head");
    const brand = el("div", "brand");
    brand.innerHTML = '<span class="b">BID</span>it';
    const live = el("div", "live hidden");
    live.innerHTML = "<i></i>LIVE";
    const conn = el("div", "conn");
    const dot = el("i", "dot");
    const connText = el("span", "conn-text", "connecting\u2026");
    conn.append(dot, connText);
    const grip = el("div", "grip", "\u283F");
    const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
    const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const themeBtn = el("button", "themebtn");
    themeBtn.title = "Toggle dark mode";
    let theme = "dark";
    const shadowHost = () => root.getRootNode()?.host;
    const renderThemeIcon = () => {
      themeBtn.innerHTML = theme === "dark" ? SUN : MOON;
    };
    const applyTheme = (t) => {
      theme = t;
      shadowHost()?.setAttribute("data-theme", t);
      renderThemeIcon();
    };
    renderThemeIcon();
    themeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    themeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        chrome.storage?.local?.set({ biditPanelTheme: next });
      } catch {
      }
    });
    try {
      chrome.storage?.local?.get("biditPanelTheme", (r) => applyTheme(r?.biditPanelTheme === "light" ? "light" : "dark"));
    } catch {
    }
    head.append(grip, brand, live, conn, themeBtn);
    const body = el("div", "body");
    const stage = el("div", "stage");
    const thumbWrap = el("div", "thumb-wrap");
    const thumb = el("img", "thumb");
    thumb.alt = "";
    thumbWrap.append(thumb);
    const info = el("div", "info");
    const title = el("div", "title", "Waiting for the next item\u2026");
    const leaderRow = el("div", "leaderrow");
    const leaderAv = el("div", "leader-av");
    const leaderText = el("span", "leadertext", "No bids yet");
    leaderRow.append(leaderAv, leaderText);
    info.append(title, leaderRow);
    stage.append(thumbWrap, info);
    const clockrow = el("div", "clockrow");
    const bidBlock = el("div", "block");
    const currentBidEl = el("div", "bid", "\u2014");
    bidBlock.append(el("div", "label", "Current bid"), currentBidEl);
    const timerBlock = el("div", "block right");
    const timerEl = el("div", "timer", "\u2014");
    const timerLabel = el("div", "label", "remaining");
    timerBlock.append(timerEl, timerLabel);
    clockrow.append(bidBlock, timerBlock);
    const progressWrap = el("div", "progresswrap");
    const progress = el("div", "progress");
    const bar = el("div", "bar");
    progress.append(bar);
    const sparkCanvas = el("canvas", "sparks");
    progressWrap.append(progress, sparkCanvas);
    const sparks = makeSparks(sparkCanvas);
    const ext = el("div", "ext", "\u23F1 EXTENDED!");
    const prizes = el("div", "prizes hidden");
    const prizesToggle = el("button", "prizestoggle");
    const prizesList = el("div", "prizeslist hidden");
    prizes.append(prizesToggle, prizesList);
    prizesToggle.addEventListener("click", () => prizesList.classList.toggle("hidden"));
    const banner = el("div", "banner");
    const feed = el("div", "feed");
    const bidBtn = el("button", "bidbtn");
    const shine = el("span", "shine");
    const bidBtnLbl = el("span", "bb-lbl", "BID");
    const bidBtnAmt = el("span", "bb-amt", "");
    bidBtn.append(shine, bidBtnLbl, bidBtnAmt);
    bidBtn.disabled = true;
    const customRow = el("div", "customrow");
    const amount = el("input", "amount");
    amount.type = "number";
    amount.step = "0.01";
    amount.placeholder = "custom amount";
    const customBtn = el("button", "custombtn", "Bid");
    customRow.append(amount, customBtn);
    body.append(stage, prizes, clockrow, progressWrap, ext, banner, feed, bidBtn, customRow);
    const empty = el("div", "empty hidden");
    const emptyText = el("div", "emptytext", "");
    empty.append(emptyText);
    const footer = el("div", "footer");
    const availEl = el("b", "avail", "\u2014");
    footer.append(el("span", "flabel", "Balance"), availEl);
    root.append(head, body, empty, footer);
    let myHandle = null;
    let endsAt = null;
    let serverOffset = 0;
    let lastLeader = null;
    let lastBid = null;
    let lastBidNum = 0;
    let lastMinNum = 0;
    let durationMs = 2e4;
    let closed = false;
    let lastAuctionId = null;
    const tick = () => {
      if (endsAt === null) return;
      const remaining = Math.max(0, endsAt - (Date.now() + serverOffset));
      timerEl.textContent = `${(remaining / 1e3).toFixed(1)}s`;
      const pct = durationMs > 0 ? Math.max(0, Math.min(100, remaining / durationMs * 100)) : 0;
      bar.style.width = `${pct}%`;
      const red = remaining > 0 && remaining <= 1e4;
      const final = remaining > 0 && remaining <= 5e3;
      timerEl.classList.toggle("red", red);
      timerEl.classList.toggle("beat", red);
      bar.classList.toggle("red", red);
      root.classList.toggle("final", final);
      sparks.setFill(pct / 100);
      if (red) sparks.start();
      else sparks.stop();
    };
    const interval = window.setInterval(tick, 100);
    bidBtn.addEventListener("click", (ev) => {
      const a = bidBtn.dataset.amount;
      if (a) {
        spawnRipple(bidBtn, ev);
        pulse(bidBtn, "pressed");
        handlers.onBid(a);
      }
    });
    customBtn.addEventListener("click", () => {
      const v = amount.value.trim();
      if (v) handlers.onBid(v);
    });
    const hostEl = () => {
      const r = root.getRootNode();
      return r instanceof ShadowRoot ? r.host : null;
    };
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    head.addEventListener("pointerdown", (ev) => {
      const host2 = hostEl();
      if (!host2) return;
      dragging = true;
      head.classList.add("grabbing");
      const rect = host2.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      startX = ev.clientX;
      startY = ev.clientY;
      host2.style.left = `${baseLeft}px`;
      host2.style.top = `${baseTop}px`;
      host2.style.right = "auto";
      host2.style.bottom = "auto";
      head.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    head.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const host2 = hostEl();
      if (!host2) return;
      const maxLeft = window.innerWidth - host2.offsetWidth - 4;
      const maxTop = window.innerHeight - 44;
      host2.style.left = `${Math.max(4, Math.min(maxLeft, baseLeft + ev.clientX - startX))}px`;
      host2.style.top = `${Math.max(4, Math.min(maxTop, baseTop + ev.clientY - startY))}px`;
    });
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      head.classList.remove("grabbing");
      try {
        head.releasePointerCapture(ev.pointerId);
      } catch {
      }
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
    const setStatus = (text, kind = "info") => {
      banner.textContent = text;
      banner.className = `banner show ${kind}`;
      if (kind === "outbid" || kind === "error") pulse(banner, "shake");
    };
    const clearStatus = () => {
      banner.className = "banner";
      banner.textContent = "";
    };
    const showBody = (show) => {
      body.classList.toggle("hidden", !show);
      empty.classList.toggle("hidden", show);
    };
    return {
      root,
      setConnected(connected, handle) {
        myHandle = handle;
        dot.className = `dot ${connected ? "on" : "off"}`;
        connText.textContent = connected ? handle ?? "connected" : "connecting\u2026";
      },
      setBalance(available) {
        availEl.textContent = available !== null ? `$${available}` : "\u2014";
      },
      applyState(s) {
        if (s.status === "RUNNING") closed = false;
        else if (closed) return;
        if (s.auctionId !== lastAuctionId) {
          lastAuctionId = s.auctionId;
          feed.replaceChildren();
          prizesList.classList.add("hidden");
        }
        const wheel = s.wheel ?? [];
        if (wheel.length > 0) {
          prizes.classList.remove("hidden");
          prizesToggle.textContent = `\u{1F3A1} ${wheel.length} prizes on the wheel`;
          if (prizesList.dataset.for !== s.auctionId) {
            prizesList.dataset.for = s.auctionId;
            prizesList.replaceChildren();
            for (const p of wheel) {
              const row = el("div", "prizerow");
              const name = el("span", "prizename");
              name.textContent = p.label;
              const qty = el("span", "prizeqty");
              qty.textContent = `\xD7${p.weight ?? 1}`;
              row.append(name, qty);
              prizesList.append(row);
            }
          }
        } else {
          prizes.classList.add("hidden");
        }
        showBody(true);
        const running = s.status === "RUNNING";
        live.classList.toggle("hidden", !running);
        title.textContent = s.title;
        if (s.imageUrl) {
          thumb.src = s.imageUrl;
          thumb.style.visibility = "visible";
        } else {
          thumb.removeAttribute("src");
        }
        if (s.currentBid) {
          const toNum = parseFloat(s.currentBid);
          if (s.currentBid !== lastBid) {
            pulse(currentBidEl, "bump");
            if (toNum > lastBidNum) countUp(currentBidEl, lastBidNum, toNum, s.currentBid);
            else currentBidEl.textContent = `$${s.currentBid}`;
          }
          lastBidNum = toNum;
        } else {
          currentBidEl.textContent = "\u2014";
          lastBidNum = 0;
        }
        lastBid = s.currentBid;
        const leadingMe = s.leaderHandle !== null && s.leaderHandle === myHandle;
        leaderRow.classList.toggle("leading", leadingMe);
        if (leadingMe && lastLeader !== myHandle) pulse(bidBtn, "win");
        leaderAv.replaceChildren();
        if (s.leaderHandle) leaderAv.append(makeAvatar(s.leaderHandle, 20));
        leaderText.textContent = leadingMe ? "You're winning \u{1F525}" : s.leaderHandle ? `${s.leaderHandle} is winning` : "No bids yet \u2014 take the lead";
        if (leadingMe) {
          setStatus("You're winning \u{1F525}", "leading");
        } else if (lastLeader === myHandle && myHandle !== null && s.leaderHandle !== null) {
          setStatus("Outbid! Bid again", "outbid");
        } else {
          clearStatus();
        }
        lastLeader = s.leaderHandle;
        bidBtn.dataset.amount = s.minNextBid;
        if (running) {
          bidBtnLbl.textContent = "BID";
          const toMin = parseFloat(s.minNextBid);
          if (lastMinNum > 0 && toMin !== lastMinNum) countUp(bidBtnAmt, lastMinNum, toMin, s.minNextBid);
          else bidBtnAmt.textContent = `$${s.minNextBid}`;
          lastMinNum = toMin;
        } else {
          bidBtnLbl.textContent = s.status === "SETTLING" ? "SOLD \u2713" : s.status === "CLOSED" ? "Auction ended" : "Auction over";
          bidBtnAmt.textContent = "";
        }
        bidBtn.disabled = !running;
        customBtn.disabled = !running;
        amount.disabled = !running;
        if (document.activeElement !== amount) amount.value = s.minNextBid;
        durationMs = s.durationSeconds * 1e3;
        endsAt = s.endsAt;
        serverOffset = s.serverNow - Date.now();
        tick();
      },
      applyClosed(c) {
        closed = true;
        live.classList.add("hidden");
        endsAt = null;
        sparks.stop();
        timerEl.textContent = "ENDED";
        timerEl.classList.remove("red", "beat");
        root.classList.remove("final");
        bar.classList.remove("red");
        bar.style.width = "0%";
        bidBtn.disabled = true;
        customBtn.disabled = true;
        amount.disabled = true;
        const won = c.winnerHandle === myHandle && myHandle !== null;
        setStatus(
          c.winnerHandle ? won ? `You won for $${c.amount}! \u{1F389}` : `Sold to ${c.winnerHandle} \xB7 $${c.amount}` : "Ended \u2014 no sale",
          won ? "leading" : "info"
        );
      },
      applyRejected(r) {
        const [text, kind] = REJECT_TEXT[r.reason] ?? [r.reason, "error"];
        setStatus(text, kind);
      },
      pushBid(handle, amount2) {
        const rowEl = el("div", "feedrow");
        rowEl.append(makeAvatar(handle, 18));
        const txt = el("span", "feedtext");
        const who = el("b");
        who.textContent = handle;
        const amt = el("b", "amt");
        amt.textContent = `$${amount2}`;
        txt.append(who, document.createTextNode(" bid "), amt);
        rowEl.append(txt);
        feed.prepend(rowEl);
        while (feed.children.length > 3) feed.lastElementChild?.remove();
        pulse(rowEl, "in");
      },
      showBidBurst(amount2) {
        spawnBidBurst(bidBtn, amount2);
        pulse(bidBtn, "win");
      },
      flashExtended() {
        pulse(ext, "show");
        pulse(bar, "refill");
      },
      setStatus,
      setNoAuction(linked) {
        showBody(false);
        live.classList.add("hidden");
        emptyText.textContent = linked ? "Waiting for the seller to start an auction\u2026" : "No BIDit auctions on this coin yet.";
      },
      destroy() {
        window.clearInterval(interval);
        sparks.destroy();
        root.remove();
      }
    };
  }

  // src/winner.ts
  var OVERLAY_ID = "bidit-winner-overlay";
  var CSS = `
.scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(60% 60% at 50% 42%, rgba(6,9,14,0.55), rgba(6,9,14,0.18)); }
.confetti { position: fixed; inset: 0; pointer-events: none; }
.card {
  position: relative; width: 320px; padding: 28px 28px 22px; text-align: center;
  border-radius: 24px; color: #eef3fb; font-family: "Inter", -apple-system, system-ui, sans-serif;
  background: rgba(12,16,24,0.94); border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 70px rgba(34,224,161,0.28);
  animation: pop 0.62s cubic-bezier(0.18,0.9,0.3,1.35) both;
}
.card.me { border-color: rgba(255,211,77,0.45); box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 80px rgba(255,211,77,0.4); }
.card.out { animation: out 0.5s ease forwards; }
.bigav { margin: 0 auto 14px; box-shadow: 0 0 0 4px rgba(255,255,255,0.08), 0 0 34px rgba(34,224,161,0.5); }
.card.me .bigav { box-shadow: 0 0 0 4px rgba(255,211,77,0.18), 0 0 36px rgba(255,211,77,0.6); }
.kicker { font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #22e0a1; }
.card.me .kicker { color: #ffd34d; }
.headline { font-size: 26px; font-weight: 900; letter-spacing: -0.01em; line-height: 1.1; margin-top: 3px; }
.card.me .headline {
  background: linear-gradient(90deg, #ffe27a, #ffb020); -webkit-background-clip: text; background-clip: text; color: transparent;
}
.item { display: flex; align-items: center; gap: 9px; justify-content: center; margin: 16px 0 4px; }
.item img { width: 38px; height: 38px; border-radius: 9px; object-fit: cover; background: #11151d; }
.item span { font-weight: 700; font-size: 14px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.price { font-size: 42px; font-weight: 900; letter-spacing: -0.02em; margin-top: 4px; font-variant-numeric: tabular-nums; }
.buyback { margin-top: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border-radius: 999px;
  font-size: 12.5px; font-weight: 800; color: #22e0a1; background: rgba(34,224,161,0.13); }
@keyframes pop {
  0% { transform: perspective(700px) rotateX(14deg) scale(0.6) translateY(26px); opacity: 0; }
  100% { transform: perspective(700px) rotateX(0) scale(1) translateY(0); opacity: 1; }
}
@keyframes out { to { transform: scale(0.95) translateY(10px); opacity: 0; } }
`;
  function el2(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  function showWinner(opts, holdMs = 4200) {
    document.getElementById(OVERLAY_ID)?.remove();
    const host2 = document.createElement("div");
    host2.id = OVERLAY_ID;
    host2.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const shadow2 = host2.attachShadow({ mode: "open" });
    const style2 = document.createElement("style");
    style2.textContent = CSS;
    shadow2.append(style2);
    const scrim = el2("div", "scrim");
    const canvas = document.createElement("canvas");
    canvas.className = "confetti";
    const card = el2("div", `card ${opts.isMe ? "me" : ""}`);
    const av = makeAvatar(opts.winnerHandle, 76);
    av.classList.add("bigav");
    const kicker = el2("div", "kicker");
    kicker.textContent = opts.isMe ? "You won" : "Sold";
    const headline = el2("div", "headline");
    headline.textContent = opts.isMe ? "WINNER! \u{1F389}" : `${opts.winnerHandle} won`;
    const item = el2("div", "item");
    if (opts.imageUrl) {
      const img = document.createElement("img");
      img.src = opts.imageUrl;
      item.append(img);
    }
    const itemName = document.createElement("span");
    itemName.textContent = opts.title;
    item.append(itemName);
    const price = el2("div", "price");
    price.textContent = `$${opts.amount}`;
    const buyback = el2("div", "buyback");
    const pumped = (parseFloat(opts.amount) * 0.05 || 0).toFixed(2);
    buyback.textContent = `+$${pumped} \u2192 $BID buyback \u{1F4C8}`;
    card.append(av, kicker, headline, item, price, buyback);
    scrim.append(canvas, card);
    shadow2.append(scrim);
    document.body.append(host2);
    runConfetti(canvas, opts.isMe);
    window.setTimeout(() => card.classList.add("out"), Math.max(0, holdMs - 600));
    window.setTimeout(() => host2.remove(), holdMs);
  }
  function runConfetti(canvas, big) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.width = window.innerWidth * dpr;
    const H = canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    const colors = big ? ["#ffd34d", "#22e0a1", "#4f8cff", "#ff7a45", "#ffffff"] : ["#22e0a1", "#4f8cff", "#9b6bff"];
    const n = big ? 170 : 80;
    const parts = Array.from({ length: n }, () => ({
      x: W * (0.32 + Math.random() * 0.36),
      y: H * 0.36 + (Math.random() - 0.5) * 40 * dpr,
      vx: (Math.random() - 0.5) * 15 * dpr,
      vy: (-9 - Math.random() * 11) * dpr,
      g: 0.36 * dpr,
      s: (5 + Math.random() * 7) * dpr,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.random() * colors.length | 0],
      life: 1
    }));
    const start = performance.now();
    let last = start;
    const frame = (t) => {
      const dt = Math.min(2.5, (t - last) / 16);
      last = t;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of parts) {
        p.vy += p.g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (t - start > 2400) p.life -= 0.018 * dt;
        if (p.life <= 0 || p.y > H + 40) continue;
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      }
      if (alive && t - start < 4200) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // src/wheel.ts
  var OVERLAY_ID2 = "bidit-wheel-overlay";
  var ROW_H = 76;
  var WINDOW_ROWS = 5;
  var CENTER_SLOT = 2;
  var TIER_COLOR = {
    Box: "#4f8cff",
    Chase: "#ff4d6d",
    Pack: "#22e0a1",
    Slab: "#ffb020",
    SIR: "#ff7a45"
  };
  var tierColor = (tier) => tier && TIER_COLOR[tier] || "#9b6bff";
  var CSS2 = `
.scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(62% 62% at 50% 46%, rgba(5,8,13,0.82), rgba(5,8,13,0.6)); }
.card {
  position: relative; width: 420px; padding: 22px 22px 20px; text-align: center;
  border-radius: 24px; color: #eaf0fb; font-family: "Inter", -apple-system, system-ui, sans-serif;
  background: rgba(11,14,20,0.96);
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 80px rgba(255,106,0,0.20);
  animation: pop 0.5s cubic-bezier(0.18,0.9,0.3,1.3) both;
}
.brand { font-weight: 800; font-size: 16px; color: #ff6a00; }
.brand .b { color: #ffffff; }
.kicker { margin-top: 14px; font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #8a93a7; }
.who { display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 20px; font-weight: 800; }
.window { position: relative; height: ${ROW_H * WINDOW_ROWS}px; margin-top: 16px; border-radius: 16px; overflow: hidden;
  background: #070a10; border: 1px solid rgba(255,255,255,0.07); }
.band { position: absolute; left: 10px; right: 10px; top: ${ROW_H * CENTER_SLOT}px; height: ${ROW_H}px;
  border-radius: 12px; background: linear-gradient(90deg, rgba(255,106,0,0.16), rgba(255,138,60,0.16));
  border: 1.5px solid rgba(255,106,0,0.55); box-shadow: 0 0 26px rgba(255,106,0,0.20) inset; z-index: 2; pointer-events: none; }
.band.land { animation: land 0.5s ease; }
.strip { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
.row { height: ${ROW_H}px; display: flex; align-items: center; gap: 12px; padding: 0 22px; box-sizing: border-box; }
.row .dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
.row .name { font-size: 19px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .tier { margin-left: auto; font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
.fade { position: absolute; left: 0; right: 0; height: ${ROW_H}px; z-index: 3; pointer-events: none; }
.fade.top { top: 0; background: linear-gradient(#070a10, rgba(7,10,16,0)); }
.fade.bot { bottom: 0; background: linear-gradient(rgba(7,10,16,0), #070a10); }
.prize { height: 26px; margin-top: 14px; font-size: 17px; font-weight: 900; opacity: 0; }
.prize.show { animation: rise 0.5s cubic-bezier(0.16,0.95,0.28,1) forwards; }
.fair { margin-top: 12px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #8a93a7; }
.fair i { width: 6px; height: 6px; border-radius: 50%; background: #ff6a00; }
.fair code { color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, monospace; }
.card.out { animation: out 0.45s ease forwards; }
@keyframes pop { 0% { transform: scale(0.7) translateY(20px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes out { to { transform: scale(0.96) translateY(8px); opacity: 0; } }
@keyframes land { 0% { transform: scale(1); } 40% { transform: scale(1.04); box-shadow: 0 0 40px rgba(255,106,0,0.6) inset; } 100% { transform: scale(1); } }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;
  function el3(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  var easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
  function showWheel(opts) {
    document.getElementById(OVERLAY_ID2)?.remove();
    const host2 = document.createElement("div");
    host2.id = OVERLAY_ID2;
    host2.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const shadow2 = host2.attachShadow({ mode: "open" });
    const style2 = document.createElement("style");
    style2.textContent = CSS2;
    shadow2.append(style2);
    const scrim = el3("div", "scrim");
    const card = el3("div", "card");
    const brand = el3("div", "brand");
    brand.innerHTML = '<span class="b">BID</span>it \xB7 WHEEL';
    const kicker = el3("div", "kicker");
    kicker.textContent = opts.isMe ? "Spinning for you" : "Assigning roll for";
    const who = el3("div", "who");
    const av = makeAvatar(opts.winnerHandle, 24);
    who.append(av, document.createTextNode(`@${opts.winnerHandle}`));
    const win = el3("div", "window");
    const band = el3("div", "band");
    const strip = el3("div", "strip");
    for (const slot of opts.reel) {
      const row = el3("div", "row");
      const dot = el3("span", "dot");
      dot.style.background = tierColor(slot.tier);
      dot.style.boxShadow = `0 0 8px ${tierColor(slot.tier)}80`;
      const name = el3("span", "name");
      name.textContent = slot.label;
      const tier = el3("span", "tier");
      tier.textContent = slot.tier ?? "";
      tier.style.color = tierColor(slot.tier);
      row.append(dot, name, tier);
      strip.append(row);
    }
    const fadeTop = el3("div", "fade top");
    const fadeBot = el3("div", "fade bot");
    win.append(strip, band, fadeTop, fadeBot);
    const prizeEl = el3("div", "prize");
    const fair = el3("div", "fair");
    fair.innerHTML = `<i></i> Provably fair \xB7 seed <code>${opts.seedHash.slice(0, 10)}\u2026</code>`;
    card.append(brand, kicker, who, win, prizeEl, fair);
    scrim.append(card);
    shadow2.append(scrim);
    document.body.append(host2);
    const offset = opts.serverNow - Date.now();
    const startY = CENTER_SLOT * ROW_H;
    const endY = (CENTER_SLOT - opts.targetIndex) * ROW_H;
    const prize = opts.reel[opts.targetIndex] ?? opts.reel[opts.reel.length - 1];
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      strip.style.transform = `translateY(${endY}px)`;
      band.classList.add("land");
      prizeEl.style.color = tierColor(prize.tier);
      prizeEl.textContent = `\u{1F389} ${prize.label}`;
      prizeEl.classList.add("show");
      window.setTimeout(() => opts.onLand(prize), 850);
      window.setTimeout(() => card.classList.add("out"), 1500);
      window.setTimeout(() => host2.remove(), 1950);
    };
    const frame = () => {
      const elapsed = Date.now() + offset - opts.startsAt;
      const p = Math.max(0, Math.min(1, elapsed / opts.durationMs));
      const y = startY + (endY - startY) * easeOutQuart(p);
      strip.style.transform = `translateY(${y}px)`;
      if (p >= 1) land();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // src/giveaway.ts
  var OVERLAY_ID3 = "bidit-giveaway-overlay";
  var TILE_W = 92;
  var CENTER_TILES = 2;
  var KIND_META = {
    PUBLIC: { label: "Everyone", color: "#22e0a1" },
    BUYER_ONLY: { label: "Buyers only", color: "#ffd34d" }
  };
  var CSS3 = `
.scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(60% 60% at 50% 44%, rgba(5,8,13,0.82), rgba(5,8,13,0.55)); }
.confetti { position: fixed; inset: 0; pointer-events: none; }
.card {
  position: relative; width: 430px; padding: 24px 24px 22px; text-align: center;
  border-radius: 26px; color: #eaf0fb; font-family: "Inter", -apple-system, system-ui, sans-serif;
  background: rgba(11,14,20,0.96); border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 90px rgba(255,106,0,0.18);
  animation: pop 0.5s cubic-bezier(0.18,0.9,0.3,1.32) both;
}
.card.win { border-color: rgba(255,211,77,0.45); box-shadow: 0 30px 90px rgba(0,0,0,0.6), 0 0 90px rgba(255,211,77,0.34); }
.card.out { animation: out 0.45s ease forwards; }
.top { display: flex; align-items: center; justify-content: center; gap: 8px; }
.brand { font-weight: 800; font-size: 15px; letter-spacing: 0.02em; color: #ff6a00; }
.brand .g { font-size: 17px; }
.brand .b { color: #ffffff; }
.kind { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; padding: 3px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; }
.kind i { width: 6px; height: 6px; border-radius: 50%; }
.kicker { margin-top: 16px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #8a93a7; }
.prize { margin-top: 5px; font-size: 27px; font-weight: 900; letter-spacing: -0.01em; line-height: 1.12;
  background: linear-gradient(90deg, #eaf0fb, #b9c6dc); -webkit-background-clip: text; background-clip: text; color: transparent; }
.host { margin-top: 6px; font-size: 12.5px; color: #8a93a7; }

/* countdown */
.count { margin-top: 16px; display: flex; align-items: baseline; justify-content: center; gap: 6px; }
.count b { font-size: 30px; font-weight: 900; font-variant-numeric: tabular-nums; }
.count span { font-size: 12px; color: #8a93a7; font-weight: 700; }
.count.low b { color: #ff5470; }
.bar { position: relative; height: 6px; margin: 12px 6px 0; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px;
  background: linear-gradient(90deg, #ff6a00, #ff8a3c); transition: width 0.12s linear; }
.bar.low > i { background: linear-gradient(90deg, #ff5470, #ff8a5b); }

/* entrant pile */
.entered { margin-top: 18px; }
.avs { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px; min-height: 34px; }
.avs .av { animation: avin 0.4s cubic-bezier(0.18,0.9,0.3,1.5) both; box-shadow: 0 0 0 2px rgba(11,14,20,1); border-radius: 50%; }
.avs .more { display: inline-flex; align-items: center; justify-content: center; height: 30px; min-width: 30px; padding: 0 8px;
  border-radius: 999px; background: rgba(255,255,255,0.08); font-size: 12px; font-weight: 800; color: #cdd6e6; }
.tally { margin-top: 10px; font-size: 13px; color: #aeb8c9; font-weight: 600; }
.tally b { color: #eaf0fb; font-variant-numeric: tabular-nums; }

/* enter button */
.enter { margin-top: 16px; width: 100%; height: 52px; border-radius: 15px; font-size: 17px; font-weight: 900; letter-spacing: 0.01em;
  color: #ffffff; background: linear-gradient(180deg, #ff8a3c, #ff6a00);
  box-shadow: 0 10px 26px rgba(255,106,0,0.4), inset 0 1px 0 rgba(255,255,255,0.32); cursor: pointer;
  transition: transform 0.1s ease, filter 0.15s ease; animation: glow 2s ease-in-out infinite; }
.enter:hover { filter: brightness(1.06); }
.enter:active { transform: translateY(1px) scale(0.99); }
.enter.done { background: rgba(34,224,161,0.16); color: #34eaad; box-shadow: none; cursor: default; animation: none; }
.enter.blocked { background: rgba(255,255,255,0.07); color: #8a93a7; box-shadow: none; cursor: not-allowed; animation: none; }
.note { margin-top: 10px; font-size: 11.5px; color: #7c8598; }

/* reveal strip */
.reel { position: relative; height: ${TILE_W + 26}px; margin: 18px 0 4px; border-radius: 18px; overflow: hidden;
  background: #070a10; border: 1px solid rgba(255,255,255,0.07); }
.spot { position: absolute; top: 50%; left: ${TILE_W * CENTER_TILES + TILE_W / 2}px; transform: translate(-50%,-50%);
  width: ${TILE_W - 8}px; height: ${TILE_W - 8}px; border-radius: 18px; z-index: 2; pointer-events: none;
  border: 2px solid rgba(255,211,77,0.85); box-shadow: 0 0 30px rgba(255,211,77,0.4), 0 0 0 2000px rgba(5,8,13,0.35); }
.spot.land { animation: spotland 0.5s ease; }
.strip { position: absolute; top: 13px; left: 0; display: flex; will-change: transform; }
.tile { width: ${TILE_W}px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.tile .av { border-radius: 16px; box-shadow: 0 0 0 2px rgba(255,255,255,0.06); }
.tile .h { max-width: ${TILE_W - 8}px; font-size: 10.5px; font-weight: 700; color: #9fb0c8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fade { position: absolute; top: 0; bottom: 0; width: 64px; z-index: 3; pointer-events: none; }
.fade.l { left: 0; background: linear-gradient(90deg, #070a10, rgba(7,10,16,0)); }
.fade.r { right: 0; background: linear-gradient(270deg, #070a10, rgba(7,10,16,0)); }

/* winner */
.wrap { display: none; }
.wrap.show { display: block; animation: rise 0.5s cubic-bezier(0.16,0.95,0.28,1) both; }
.wbig { margin: 4px auto 12px; box-shadow: 0 0 0 4px rgba(255,211,77,0.2), 0 0 40px rgba(255,211,77,0.6); border-radius: 22px; }
.wkick { font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #ffd34d; }
.whead { margin-top: 3px; font-size: 26px; font-weight: 900; letter-spacing: -0.01em;
  background: linear-gradient(90deg, #ffe27a, #ffb020); -webkit-background-clip: text; background-clip: text; color: transparent; }
.wprize { margin-top: 8px; font-size: 15px; font-weight: 700; color: #eaf0fb; }
.wprize b { color: #ffd34d; }
.fair { margin-top: 14px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #8a93a7; }
.fair i { width: 6px; height: 6px; border-radius: 50%; background: #ff6a00; }
.fair code { color: #9cc0ff; font-family: ui-monospace, SFMono-Regular, monospace; }

@keyframes pop { 0% { transform: scale(0.72) translateY(18px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes out { to { transform: scale(0.96) translateY(8px); opacity: 0; } }
@keyframes avin { 0% { transform: scale(0) translateY(-8px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes glow { 0%,100% { box-shadow: 0 10px 26px rgba(255,106,0,0.34), inset 0 1px 0 rgba(255,255,255,0.32); }
  50% { box-shadow: 0 10px 34px rgba(255,106,0,0.62), inset 0 1px 0 rgba(255,255,255,0.32); } }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spotland { 0% { transform: translate(-50%,-50%) scale(1); } 45% { transform: translate(-50%,-50%) scale(1.12); } 100% { transform: translate(-50%,-50%) scale(1); } }
`;
  function el4(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  var easeOutQuart2 = (p) => 1 - Math.pow(1 - p, 4);
  function showGiveaway(opts) {
    document.getElementById(OVERLAY_ID3)?.remove();
    const host2 = document.createElement("div");
    host2.id = OVERLAY_ID3;
    host2.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const shadow2 = host2.attachShadow({ mode: "open" });
    const style2 = document.createElement("style");
    style2.textContent = CSS3;
    shadow2.append(style2);
    const scrim = el4("div", "scrim");
    scrim.style.pointerEvents = "auto";
    const canvas = document.createElement("canvas");
    canvas.className = "confetti";
    const card = el4("div", "card");
    const meta = KIND_META[opts.kind];
    const top = el4("div", "top");
    const brand = el4("div", "brand");
    brand.innerHTML = '<span class="g">\u{1F381}</span> <span class="b">BID</span>it giveaway';
    const kind = el4("span", "kind");
    kind.style.color = meta.color;
    kind.style.background = `${meta.color}22`;
    kind.innerHTML = `<i style="background:${meta.color}"></i>${meta.label}`;
    top.append(brand, kind);
    const kicker = el4("div", "kicker");
    kicker.textContent = "Up for grabs";
    const prize = el4("div", "prize");
    prize.textContent = opts.prize;
    const hostLine = el4("div", "host");
    hostLine.textContent = `from @${opts.sellerHandle}`;
    const count = el4("div", "count");
    const countNum = document.createElement("b");
    const countUnit = el4("span");
    countUnit.textContent = "left to enter";
    count.append(countNum, countUnit);
    const bar = el4("div", "bar");
    const barFill = el4("i");
    bar.append(barFill);
    const entered = el4("div", "entered");
    const avs = el4("div", "avs");
    const tally = el4("div", "tally");
    entered.append(avs, tally);
    const enterBtn = document.createElement("button");
    enterBtn.className = opts.eligible ? "enter" : "enter blocked";
    enterBtn.textContent = opts.eligible ? "Enter giveaway" : "Buyers only \u2014 purchase to enter";
    let entered_ = false;
    enterBtn.onclick = () => {
      if (entered_ || !opts.eligible) return;
      opts.onEnter();
    };
    const note = el4("div", "note");
    note.textContent = opts.kind === "BUYER_ONLY" ? "Only people who bought from this seller can win." : "Free to enter \xB7 one entry per viewer.";
    const reel = el4("div", "reel");
    reel.style.display = "none";
    const spot = el4("div", "spot");
    const strip = el4("div", "strip");
    const fadeL = el4("div", "fade l");
    const fadeR = el4("div", "fade r");
    reel.append(strip, spot, fadeL, fadeR);
    const winWrap = el4("div", "wrap");
    card.append(top, kicker, prize, hostLine, count, bar, entered, enterBtn, note, reel, winWrap);
    scrim.append(canvas, card);
    shadow2.append(scrim);
    document.body.append(host2);
    const offset = opts.serverNow - Date.now();
    const span = Math.max(1, opts.closesAt - opts.opensAt);
    let count_ = opts.entrantCount;
    let recent_ = [];
    let revealing = false;
    let removed = false;
    const renderPile = () => {
      avs.replaceChildren();
      const show = recent_.slice(0, 7);
      for (const e of show) {
        const av = makeAvatar(e.handle, 30);
        av.classList.add("av");
        avs.append(av);
      }
      const extra = count_ - show.length;
      if (extra > 0) {
        const more = el4("span", "more");
        more.textContent = `+${extra}`;
        avs.append(more);
      }
      tally.innerHTML = count_ === 0 ? "Be the first to enter" : `<b>${count_}</b> ${count_ === 1 ? "viewer" : "viewers"} entered`;
    };
    renderPile();
    let raf = 0;
    const tick = () => {
      if (revealing || removed) return;
      const now = Date.now() + offset;
      const remainMs = Math.max(0, opts.closesAt - now);
      const secs = remainMs / 1e3;
      countNum.textContent = secs >= 10 ? Math.ceil(secs).toString() : secs.toFixed(1);
      const pct = Math.max(0, Math.min(100, remainMs / span * 100));
      barFill.style.width = `${pct}%`;
      const low = remainMs <= 5e3;
      count.classList.toggle("low", low);
      bar.classList.toggle("low", low);
      if (remainMs <= 0) {
        countUnit.textContent = "drawing\u2026";
        countNum.textContent = "0";
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const reveal = (r) => {
      if (removed) return;
      revealing = true;
      cancelAnimationFrame(raf);
      for (const n of [kicker, count, bar, entered, enterBtn, note]) n.style.display = "none";
      kicker.textContent = "Drawing the winner";
      reel.style.display = "block";
      for (const e of r.roll) {
        const tile = el4("div", "tile");
        const av = makeAvatar(e.handle, TILE_W - 20);
        av.classList.add("av");
        const h = el4("div", "h");
        h.textContent = `@${e.handle}`;
        tile.append(av, h);
        strip.append(tile);
      }
      const roffset = r.serverNow - Date.now();
      const startX = CENTER_TILES * TILE_W;
      const endX = (CENTER_TILES - r.targetIndex) * TILE_W;
      let landed = false;
      const land = () => {
        if (landed) return;
        landed = true;
        strip.style.transform = `translateX(${endX}px)`;
        spot.classList.add("land");
        card.classList.add("win");
        const wbig = makeAvatar(r.winnerHandle, 76);
        wbig.classList.add("wbig");
        const wkick = el4("div", "wkick");
        wkick.textContent = r.isMe ? "You won!" : "Winner";
        const whead = el4("div", "whead");
        whead.textContent = r.isMe ? "\u{1F389} YOU WON! \u{1F389}" : `@${r.winnerHandle}`;
        const wprize = el4("div", "wprize");
        wprize.innerHTML = `wins <b>${r.prize}</b>`;
        const fair = el4("div", "fair");
        fair.innerHTML = `<i></i> Provably fair \xB7 seed <code>${r.seedHash.slice(0, 10)}\u2026</code>`;
        winWrap.append(wbig, wkick, whead, wprize, fair);
        winWrap.classList.add("show");
        runConfetti2(canvas);
        window.setTimeout(() => card.classList.add("out"), 5200);
        window.setTimeout(() => api.close(), 5650);
      };
      const frame = () => {
        if (removed) return;
        const elapsed = Date.now() + roffset - r.startsAt;
        const p = Math.max(0, Math.min(1, elapsed / r.durationMs));
        const x = startX + (endX - startX) * easeOutQuart2(p);
        strip.style.transform = `translateX(${x}px)`;
        if (p >= 1) land();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    const api = {
      giveawayId: opts.giveawayId,
      updateEntries: (c, recent) => {
        if (revealing) return;
        count_ = c;
        recent_ = recent;
        renderPile();
      },
      markEntered: () => {
        entered_ = true;
        enterBtn.className = "enter done";
        enterBtn.textContent = "You're in \u2713";
      },
      markRejected: (reason) => {
        enterBtn.className = "enter blocked";
        enterBtn.textContent = reason === "NOT_ELIGIBLE" ? "Buyers only \u2014 purchase to enter" : "Entry closed";
      },
      reveal,
      close: () => {
        if (removed) return;
        removed = true;
        cancelAnimationFrame(raf);
        host2.remove();
      }
    };
    return api;
  }
  function runConfetti2(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.width = window.innerWidth * dpr;
    const H = canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    const colors = ["#ffd34d", "#22e0a1", "#4f8cff", "#ff7a45", "#ffffff"];
    const parts = Array.from({ length: 180 }, () => ({
      x: W * (0.3 + Math.random() * 0.4),
      y: H * 0.4 + (Math.random() - 0.5) * 40 * dpr,
      vx: (Math.random() - 0.5) * 16 * dpr,
      vy: (-9 - Math.random() * 12) * dpr,
      g: 0.36 * dpr,
      s: (5 + Math.random() * 7) * dpr,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.random() * colors.length | 0],
      life: 1
    }));
    const start = performance.now();
    let last = start;
    const frame = (t) => {
      const dt = Math.min(2.5, (t - last) / 16);
      last = t;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of parts) {
        p.vy += p.g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (t - start > 2600) p.life -= 0.017 * dt;
        if (p.life <= 0 || p.y > H + 40) continue;
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      }
      if (alive && t - start < 5200) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ../shared/src/enums.ts
  function asEnum(o) {
    return Object.freeze(o);
  }
  var Role = asEnum({
    buyer: "buyer",
    seller: "seller",
    admin: "admin"
  });
  var AccountKind = asEnum({
    USER: "USER",
    PLATFORM: "PLATFORM",
    EXTERNAL: "EXTERNAL",
    ESCROW: "ESCROW"
  });
  var LedgerType = asEnum({
    DEPOSIT: "DEPOSIT",
    WITHDRAWAL: "WITHDRAWAL",
    BID_HOLD: "BID_HOLD",
    BID_HOLD_RELEASE: "BID_HOLD_RELEASE",
    PURCHASE_DEBIT: "PURCHASE_DEBIT",
    PAYOUT_CREDIT: "PAYOUT_CREDIT",
    PLATFORM_FEE: "PLATFORM_FEE",
    REFUND: "REFUND",
    ESCROW_LOCK: "ESCROW_LOCK",
    ESCROW_RELEASE: "ESCROW_RELEASE"
  });
  var LedgerRefType = asEnum({
    DEPOSIT: "DEPOSIT",
    WITHDRAWAL: "WITHDRAWAL",
    ORDER: "ORDER",
    AUCTION: "AUCTION",
    BID: "BID",
    ADJUSTMENT: "ADJUSTMENT",
    TRANSFER: "TRANSFER",
    EXTERNAL: "EXTERNAL"
  });
  var ListingStatus = asEnum({
    DRAFT: "DRAFT",
    QUEUED: "QUEUED",
    LIVE: "LIVE",
    SOLD: "SOLD",
    UNSOLD: "UNSOLD",
    CANCELED: "CANCELED"
  });
  var AuctionStatus = asEnum({
    PENDING: "PENDING",
    RUNNING: "RUNNING",
    SETTLING: "SETTLING",
    CLOSED: "CLOSED",
    CANCELED: "CANCELED"
  });
  var BidStatus = asEnum({
    ACTIVE: "ACTIVE",
    OUTBID: "OUTBID",
    WON: "WON",
    LOST: "LOST",
    VOID: "VOID"
  });
  var OrderStatus = asEnum({
    PENDING_SETTLEMENT: "PENDING_SETTLEMENT",
    LOCKED: "LOCKED",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED",
    DISPUTE_WINDOW: "DISPUTE_WINDOW",
    DISPUTED: "DISPUTED",
    RELEASED: "RELEASED",
    REFUNDED: "REFUNDED",
    CANCELED: "CANCELED"
  });
  var HoldStatus = asEnum({
    ACTIVE: "ACTIVE",
    RELEASED: "RELEASED",
    CAPTURED: "CAPTURED"
  });

  // ../shared/src/auction.ts
  var BidRejectReason = {
    AUCTION_NOT_FOUND: "AUCTION_NOT_FOUND",
    AUCTION_ENDED: "AUCTION_ENDED",
    BID_TOO_LOW: "BID_TOO_LOW",
    ALREADY_LEADING: "ALREADY_LEADING",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE"
  };

  // ../shared/src/randomizer.ts
  var REEL_REPEATS = 8;
  function buildReel(entries, prizeIndex, repeats = REEL_REPEATS) {
    if (entries.length === 0) throw new Error("wheel has no entries");
    const reps = Math.max(4, repeats);
    const reel = [];
    for (let r = 0; r < reps; r++) {
      for (const e of entries) {
        const slot = { label: e.label };
        if (e.tier) slot.tier = e.tier;
        if (e.imageUrl) slot.imageUrl = e.imageUrl;
        reel.push(slot);
      }
    }
    const targetIndex = (reps - 3) * entries.length + prizeIndex;
    return { reel, targetIndex };
  }

  // ../shared/src/giveaway.ts
  var ROLL_REPEATS = 6;
  function buildRollOrder(entrants, winnerIndex, repeats = ROLL_REPEATS) {
    if (entrants.length === 0) throw new Error("giveaway has no entrants");
    const reps = Math.max(3, repeats);
    const roll = [];
    for (let r = 0; r < reps; r++) roll.push(...entrants);
    const targetIndex = (reps - 2) * entrants.length + winnerIndex;
    return { roll, targetIndex };
  }

  // ../shared/src/protocol.ts
  var RealtimeRejectReason = {
    ...BidRejectReason,
    RATE_LIMITED: "RATE_LIMITED"
  };

  // src/panel.css
  var panel_default = `/* Scoped inside the panel's shadow root \u2014 class names can't collide with Pump's.
   Theme: White Clean \u2014 white panel, navy text, orange CTA. */
:host {
  all: initial;
  position: fixed;
  top: 76px;
  right: 18px;
  z-index: 2147483000;
  font-family: "Inter", -apple-system, system-ui, "Segoe UI", sans-serif;
  --navy: #0b2447;
  --ink: #0b2447;
  --muted: #5c6e88;
  --good: #0e9f6e;
  --accent: #ff6a00;
  --accent-2: #ff8a3c;
  --red: #ef3b4e;
  --amber: #e0a012;
  --line: rgba(11, 36, 71, 0.10);
  --surface: #ffffff;
  --surface-2: #f1f5fb;
  --surface-3: #e6edf6;
}
/* Dark "Navy Immersive": navy surfaces, white text, orange stays. */
:host([data-theme="dark"]) {
  --ink: #ffffff;
  --muted: #8ca0bd;
  --good: #22c58a;
  --red: #ff5a6a;
  --amber: #f0b429;
  --line: rgba(255, 255, 255, 0.11);
  --surface: #0b2447;
  --surface-2: #10233f;
  --surface-3: #17304f;
}
:host([data-theme="dark"]) .panel {
  border-color: rgba(255, 255, 255, 0.10);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
:host([data-theme="dark"]) .banner.info { background: rgba(255, 255, 255, 0.08); color: #cfe0f5; }
* { box-sizing: border-box; margin: 0; }

.panel {
  position: relative;
  width: 392px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 24px 70px rgba(11, 36, 71, 0.28), 0 2px 8px rgba(11, 36, 71, 0.12);
  color: var(--ink);
  overflow: hidden;
}
.panel > * { position: relative; }
.head, .body, .footer { background: var(--surface); }

.head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--line);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.head.grabbing { cursor: grabbing; }
.grip {
  font-size: 14px; line-height: 1; color: var(--muted); opacity: 0.55;
  letter-spacing: -2px; margin-right: -2px; transform: translateY(-1px);
}
.head:hover .grip { opacity: 1; color: var(--ink); }
.brand { font-weight: 800; font-size: 18px; letter-spacing: -0.01em; color: var(--accent); }
.brand .b { color: var(--ink); }
.live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--red);
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(239, 59, 78, 0.10);
}
.live i { width: 6px; height: 6px; border-radius: 50%; background: var(--red); animation: live 1.4s ease-in-out infinite; }
.conn { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.themebtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: none;
  border: 0; border-radius: 8px; padding: 0; cursor: pointer; color: var(--muted); background: transparent; }
.themebtn:hover { color: var(--ink); background: var(--surface-2); }
.themebtn svg { width: 16px; height: 16px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--amber); }
.dot.on { background: var(--good); box-shadow: 0 0 8px rgba(14, 159, 110, 0.45); }
.dot.off { background: var(--red); }

.body { padding: 16px; }

.stage { display: flex; gap: 13px; align-items: center; }
.thumb-wrap {
  width: 82px; height: 82px; flex: none; border-radius: 13px; padding: 2px;
  background: linear-gradient(150deg, var(--navy), var(--accent));
}
.thumb { width: 100%; height: 100%; border-radius: 11px; object-fit: cover; background: var(--surface-3); display: block; }
.info { min-width: 0; }
.title { font-weight: 700; font-size: 16.5px; line-height: 1.25; color: var(--ink); }
.leaderrow { display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 13px; color: var(--muted); }
.leaderrow.leading { color: var(--good); font-weight: 700; }
.leader-av:empty { display: none; }

.feed { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.feed:empty { display: none; }
.feedrow { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); }
.feedrow b { color: var(--ink); font-weight: 700; }
.feedrow .amt { color: var(--ink); font-weight: 700; }
.feedrow.in { animation: feedin 0.35s ease; }
@keyframes feedin { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }

.clockrow { display: flex; align-items: flex-end; justify-content: space-between; margin-top: 14px; }
.block.right { text-align: right; }
.label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 2px; }
.bid { font-size: 38px; font-weight: 800; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--ink); }
.timer { font-size: 36px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; color: var(--ink); transform-origin: center; }
/* <=10s: red + heartbeat. The .final (last 5s) variant beats faster + harder. */
.timer.red { color: var(--red); text-shadow: 0 0 16px rgba(239, 59, 78, 0.35); }
.timer.beat { animation: beat 1s ease-in-out infinite; }
.panel.final .timer.beat { animation-duration: 0.5s; }

/* The bar lives in a relative wrapper so the spark canvas can overflow above it. */
.progresswrap { position: relative; margin-top: 13px; }
.progress { height: 7px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.bar {
  height: 100%; width: 100%; border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.12s linear;
}
.bar.red {
  background: linear-gradient(90deg, var(--red), #ff7a45);
  box-shadow: 0 0 10px rgba(239, 59, 78, 0.5);
}
/* Spark layer \u2014 sits over the bar, sparks fly up out of it. Pointer-transparent. */
.sparks {
  position: absolute; left: 0; bottom: -1px; width: 100%; height: 40px;
  pointer-events: none;
}
/* Anti-snipe refill: a quick glow sweep when the deadline jumps forward. */
.bar.refill { animation: refill 0.6s ease; }

/* "EXTENDED!" badge \u2014 collapsed by default, pops on flashExtended(). */
.ext {
  height: 0; opacity: 0; overflow: hidden; transform: scale(0.8);
  margin: 0 auto; width: max-content;
  border-radius: 999px; font-size: 12px; font-weight: 900; letter-spacing: 0.04em;
  color: #fff; background: linear-gradient(96deg, var(--red), #ff7a45);
  box-shadow: 0 6px 18px rgba(239, 59, 78, 0.4);
}
.ext.show { animation: extpop 1.25s cubic-bezier(0.2, 0.9, 0.3, 1.3); }

.banner {
  max-height: 0; opacity: 0; overflow: hidden;
  margin-top: 0; padding: 0 12px;
  border-radius: 10px; font-size: 13px; font-weight: 700; text-align: center;
  transition: max-height 0.18s ease, opacity 0.18s ease, margin 0.18s ease, padding 0.18s ease;
}
.banner.show { max-height: 40px; opacity: 1; margin-top: 11px; padding: 9px 12px; }
.banner.leading { background: rgba(14, 159, 110, 0.12); color: var(--good); }
.banner.outbid { background: rgba(239, 59, 78, 0.12); color: var(--red); }
.banner.error { background: rgba(239, 59, 78, 0.10); color: var(--red); }
.banner.info { background: rgba(11, 36, 71, 0.07); color: var(--navy); }

.bidbtn {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  position: relative; overflow: hidden;
  width: 100%; margin-top: 14px;
  padding: 16px; border: 0; border-radius: 14px; cursor: pointer;
  font-size: 18.5px; font-weight: 800; letter-spacing: 0.01em; color: #ffffff;
  background: linear-gradient(96deg, var(--accent), var(--accent-2));
  box-shadow: 0 10px 24px rgba(255, 106, 0, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  transition: transform 0.08s ease, box-shadow 0.2s ease, filter 0.2s ease;
}
.bidbtn:hover { filter: brightness(1.05); box-shadow: 0 14px 30px rgba(255, 106, 0, 0.42); }
.bidbtn:active { transform: translateY(1px) scale(0.99); }
.bidbtn.pressed { animation: press 0.22s ease; }
.bidbtn.win { animation: winpop 0.5s ease; }
.bb-lbl { position: relative; z-index: 1; }
.bb-amt { position: relative; z-index: 1; font-variant-numeric: tabular-nums; }
/* Glossy highlight that sweeps across the live button every few seconds. */
.shine {
  position: absolute; top: 0; bottom: 0; left: -40%; width: 28%;
  transform: skewX(-20deg); pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
}
.bidbtn:not(:disabled) .shine { animation: shine 3.6s ease-in-out infinite; }
/* Tap ripple \u2014 sized + positioned inline in JS, expands then fades. */
.ripple {
  position: absolute; border-radius: 50%; pointer-events: none;
  background: rgba(255, 255, 255, 0.45);
  transform: scale(0); animation: ripple 0.6s ease-out forwards;
}
.bidburst {
  position: absolute; right: 18px; top: -10px; z-index: 3; pointer-events: none;
  padding: 5px 9px; border-radius: 999px;
  background: var(--navy); color: #fff;
  font-size: 13px; font-weight: 950; font-variant-numeric: tabular-nums;
  box-shadow: 0 8px 22px rgba(255, 106, 0, 0.42);
  animation: bidburst 0.85s cubic-bezier(0.16, 0.95, 0.28, 1) forwards;
}
.bidbtn:disabled {
  background: var(--surface-3); color: var(--muted);
  box-shadow: none; cursor: not-allowed;
}

.customrow { display: flex; gap: 8px; margin-top: 9px; }
.amount {
  flex: 1; min-width: 0; background: var(--surface-2);
  border: 1px solid var(--line); color: var(--ink);
  border-radius: 10px; padding: 9px 12px; font-size: 14px;
}
.amount:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 106, 0, 0.14); }
.custombtn {
  background: var(--surface-2); color: var(--ink); border: 1px solid var(--line);
  border-radius: 10px; padding: 9px 14px; font-size: 13px; font-weight: 700; cursor: pointer;
}
.custombtn:hover { background: var(--surface-3); }
.custombtn:disabled { opacity: 0.4; cursor: not-allowed; }

.empty { padding: 22px 16px; text-align: center; }
.emptytext { color: var(--muted); font-size: 13px; }
.seedbtn {
  margin-top: 12px; padding: 10px 16px; border: 0; border-radius: 10px; cursor: pointer;
  font-weight: 700; font-size: 13px; color: #fff;
  background: linear-gradient(96deg, var(--accent), var(--accent-2));
}

.footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 14px; border-top: 1px solid var(--line);
  font-size: 13px; color: var(--muted);
}
.footer .avail { color: var(--ink); font-weight: 800; font-variant-numeric: tabular-nums; }

.hidden { display: none !important; }

@keyframes live { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes press { 0% { transform: scale(1); } 40% { transform: scale(0.96); } 100% { transform: scale(1); } }
@keyframes bump {
  0% { transform: scale(1); }
  35% { transform: scale(1.18); color: var(--accent); }
  100% { transform: scale(1); }
}
.bump { animation: bump 0.4s ease; }
@keyframes shakeit {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-5px); }
  40% { transform: translateX(5px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(3px); }
}
.shake { animation: shakeit 0.4s ease; }

/* Bid-button juice ------------------------------------------------------ */
@keyframes shine { 0% { left: -40%; } 14% { left: 130%; } 100% { left: 130%; } }
@keyframes ripple { to { transform: scale(2.5); opacity: 0; } }
@keyframes bidburst {
  0% { opacity: 0; transform: translateY(8px) scale(0.72); }
  14% { opacity: 1; transform: translateY(-8px) scale(1.08); }
  55% { opacity: 1; transform: translateY(-24px) scale(1); }
  100% { opacity: 0; transform: translateY(-42px) scale(0.94); }
}
@keyframes winpop {
  0% { transform: scale(1); }
  35% { transform: scale(1.045); box-shadow: 0 0 0 4px rgba(255, 106, 0, 0.32), 0 16px 34px rgba(255, 106, 0, 0.45); }
  100% { transform: scale(1); }
}

/* Final-seconds drama --------------------------------------------------- */
/* Lub-dub heartbeat for the countdown number once it goes red. */
@keyframes beat {
  0%, 100% { transform: scale(1); }
  15% { transform: scale(1.17); }
  30% { transform: scale(1); }
  45% { transform: scale(1.09); }
  60% { transform: scale(1); }
}
/* Whole-panel red glow pulse in the last 5 seconds. */
.panel.final { animation: finalglow 1s ease-in-out infinite; }
@keyframes finalglow {
  0%, 100% { box-shadow: 0 24px 70px rgba(11, 36, 71, 0.28), 0 0 0 1px rgba(239, 59, 78, 0.35); }
  50% { box-shadow: 0 24px 70px rgba(11, 36, 71, 0.28), 0 0 26px 2px rgba(239, 59, 78, 0.55); }
}
/* Bar glow-sweep when the deadline jumps forward (anti-snipe). */
@keyframes refill {
  0% { filter: brightness(1.6); box-shadow: 0 0 16px rgba(255, 138, 60, 0.85); }
  100% { filter: brightness(1); box-shadow: none; }
}
/* "EXTENDED!" badge: pop in, hold, collapse \u2014 one-shot, self-hiding. */
@keyframes extpop {
  0% { height: 0; opacity: 0; transform: scale(0.8); margin-top: 0; padding: 0 14px; }
  12% { height: 30px; opacity: 1; transform: scale(1.08); margin-top: 11px; padding: 7px 14px; }
  22% { transform: scale(1); }
  80% { height: 30px; opacity: 1; transform: scale(1); margin-top: 11px; padding: 7px 14px; }
  100% { height: 0; opacity: 0; transform: scale(0.9); margin-top: 0; padding: 0 14px; }
}

/* randomizer prize pool ("what's on the wheel") */
.prizes { margin: 0 var(--pad) 8px; }
.prizestoggle { width: 100%; height: 32px; border-radius: 9px; border: 1px solid var(--line); cursor: pointer;
  background: var(--surface-2); color: var(--ink); font-size: 12.5px; font-weight: 600; }
.prizestoggle:hover { background: var(--surface-3); }
.prizeslist { margin-top: 6px; max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.prizerow { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 7px;
  font-size: 12.5px; background: var(--surface-2); }
.prizename { flex: 1; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prizeqty { color: var(--muted); font-weight: 800; font-variant-numeric: tabular-nums; }
`;

  // dev/preview-entry.ts
  var host = document.getElementById("host");
  var shadow = host.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = panel_default;
  shadow.append(style);
  var panel = createPanel({ onBid: (a) => console.log("bid", a) });
  shadow.append(panel.root);
  window.__panel = panel;
  var IMG = "https://images.pokemontcg.io/base1/4_hires.png";
  panel.setConnected(true, "luna_degen");
  panel.setBalance("87", "100");
  var HANDLES = ["degen_max", "cryptochad", "luna_degen", "apex_whale", "mintking"];
  var bid = 12;
  var i = 0;
  var snipe = () => {
    bid += 1 + Math.floor(Math.random() * 5);
    const who = HANDLES[i++ % HANDLES.length];
    const now = Date.now();
    panel.applyState({
      type: "AUCTION_STATE",
      room: "demo",
      auctionId: "demo-auction",
      title: "Charizard \u2014 Base Set Holo",
      imageUrl: IMG,
      status: "RUNNING",
      currentBid: String(bid),
      leaderHandle: who,
      minNextBid: String(bid + 1),
      durationSeconds: 20,
      endsAt: now + 4200,
      // inside the 5s window -> final-seconds drama
      serverNow: now
    });
    panel.pushBid(who, String(bid));
    if (who === "luna_degen") panel.showBidBurst(String(bid));
    panel.flashExtended();
  };
  snipe();
  var loop = window.setInterval(snipe, 2600);
  function mkBtn(id, label, left, bg, onClick) {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = label;
    b.style.cssText = `position:fixed;left:${left}px;bottom:20px;z-index:5;padding:11px 18px;border-radius:11px;border:0;background:${bg};color:#06251a;font-weight:800;font-size:14px;cursor:pointer;font-family:system-ui;`;
    b.onclick = onClick;
    document.body.append(b);
  }
  mkBtn("flash", "Flash EXTENDED", 20, "#ff7a45", () => panel.flashExtended());
  mkBtn("pause", "Pause snipes", 168, "#ffb020", () => window.clearInterval(loop));
  mkBtn(
    "replay",
    "Replay win",
    300,
    "#22e0a1",
    () => showWinner(
      { winnerHandle: "nadimnah", amount: "42", title: "Charizard \u2014 Base Set Holo", imageUrl: IMG, isMe: true },
      6e5
      // hold open for the screenshot
    )
  );
  var WHEEL = [
    { label: "Destined Rivals ETB", tier: "Box" },
    { label: "Sealed Booster Box", tier: "Box" },
    { label: "Charizard ex \u2014 Alt Art", tier: "Chase" },
    { label: "Pikachu ex \u2014 SIR", tier: "SIR" },
    { label: "Umbreon ex \u2014 SIR", tier: "SIR" },
    { label: "Sleeved Booster \xD74", tier: "Pack" },
    { label: "Single Booster Pack", tier: "Pack" },
    { label: "Mystery Slab", tier: "Slab" }
  ];
  function spinWheel(prizeIndex, elapsedMs = -400, durationMs = 5200) {
    window.clearInterval(loop);
    const { reel, targetIndex } = buildReel(WHEEL, prizeIndex);
    const now = Date.now();
    showWheel({
      reel,
      targetIndex,
      durationMs,
      startsAt: now - elapsedMs,
      // elapsedMs<0 starts in the future (normal); >0 jumps mid-spin for capture
      serverNow: now,
      winnerHandle: "luna_degen",
      amount: "64",
      seedHash: "9f3a1c4e7b2d8a05f1",
      isMe: true,
      onLand: (prize) => showWinner({ winnerHandle: "luna_degen", amount: "64", title: prize.label, imageUrl: IMG, isMe: true }, 6e5)
    });
  }
  mkBtn("wheel", "Spin wheel", 432, "#9b6bff", () => spinWheel(Math.floor(Math.random() * WHEEL.length)));
  window.__spin = spinWheel;
  var GA_HANDLES = [
    "degen_max",
    "cryptochad",
    "luna_degen",
    "apex_whale",
    "mintking",
    "pack_ripper",
    "holo_hunter",
    "slabgod",
    "chase_queen",
    "mint_maxi"
  ];
  var GA_PRIZE = "Charizard ex \u2014 Alt Art Slab";
  var ga = null;
  var gaFill;
  function openGiveaway(kind = "PUBLIC", durationMs = 2e4) {
    window.clearInterval(loop);
    if (gaFill) window.clearInterval(gaFill);
    const now = Date.now();
    ga = showGiveaway({
      giveawayId: "demo-ga",
      kind,
      prize: GA_PRIZE,
      sellerHandle: "kareem",
      opensAt: now,
      closesAt: now + durationMs,
      serverNow: now,
      entrantCount: 0,
      eligible: true,
      onEnter: () => ga?.markEntered()
    });
    let entrants = [];
    gaFill = window.setInterval(() => {
      if (entrants.length >= GA_HANDLES.length) return;
      const h = GA_HANDLES[entrants.length];
      entrants = [{ userId: h, handle: h }, ...entrants];
      ga?.updateEntries(entrants.length + 23, entrants);
    }, 450);
  }
  function revealGiveaway(winnerIdx = 3, kind = "PUBLIC", startedMsAgo = -200) {
    if (!ga) openGiveaway(kind);
    if (gaFill) window.clearInterval(gaFill);
    const entrants = GA_HANDLES.map((h) => ({ userId: h, handle: h }));
    const idx = (winnerIdx % entrants.length + entrants.length) % entrants.length;
    const { roll, targetIndex } = buildRollOrder(entrants, idx);
    const now = Date.now();
    const w = entrants[idx];
    ga.reveal({
      prize: GA_PRIZE,
      winnerHandle: w.handle,
      roll,
      targetIndex,
      durationMs: 5200,
      startsAt: now - startedMsAgo,
      serverNow: now,
      seedHash: "a1b2c3d4e5f6a7b8",
      isMe: w.handle === "luna_degen"
    });
  }
  mkBtn("giveaway", "Giveaway", 560, "#22e0a1", () => openGiveaway("PUBLIC"));
  mkBtn("gadraw", "Draw GA", 690, "#ffd34d", () => revealGiveaway(2));
  window.__giveaway = {
    open: openGiveaway,
    reveal: revealGiveaway
  };
})();
