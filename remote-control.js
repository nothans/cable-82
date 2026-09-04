/* CABLE 82 remote control. Four keys, each one a POST to the tuner bus.
   The remote holds no state and shows no channel: the original had no
   display either, you looked at the set. What it does show is whether a
   press landed - how many sets are listening, or why none can. */
(() => {
  "use strict";

  const KEYS = {
    down: { cmd: "down", said: "Channel lower" },
    volume: { cmd: "volume", said: "Volume" },
    power: { cmd: "power", said: "Off-On" },
    up: { cmd: "up", said: "Channel higher" },
  };

  const status = document.getElementById("status");
  const keys = Array.from(document.querySelectorAll(".key"));

  function say(text, warn) {
    status.textContent = text;
    status.classList.toggle("warn", !!warn);
  }
  function listening(n) {
    return n === 1 ? "One set is listening." : n + " sets are listening.";
  }

  async function press(name) {
    const key = KEYS[name];
    if (!key) return;
    if (navigator.vibrate) navigator.vibrate(12); // the key's travel, felt not heard
    try {
      const r = await fetch("api/tune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: key.cmd }),
      });
      if (r.status === 403) return say("HTTP tuning is switched off. Turn it on in the control room.", true);
      if (!r.ok) return say("The server answered " + r.status + ".", true);
      const j = await r.json();
      if (!j.listeners) return say(key.said + ". No set is listening: open the display first.", true);
      say(key.said + ". " + listening(j.listeners));
    } catch (e) {
      say("Can't reach the server.", true);
    }
  }

  // Is anyone out there? Asked once on load so an idle remote already says
  // whether a press would land.
  async function probe() {
    try {
      const r = await fetch("api/tune", { cache: "no-store" });
      if (r.status === 403) return say("HTTP tuning is switched off. Turn it on in the control room.", true);
      if (!r.ok) return;
      const j = await r.json();
      if (!j.listeners) return say("No set is listening: open the display first.", true);
      say("Tap a key. " + listening(j.listeners));
    } catch (e) {
      say("Can't reach the server.", true);
    }
  }

  // A press sends on pointerdown, the moment the thumb lands, and the cap
  // stays down until the thumb lifts. Enter and Space do the same from a
  // keyboard. click is swallowed so a pointer press never sends twice.
  for (const b of keys) {
    const name = b.dataset.cmd;
    const lift = () => b.classList.remove("down");
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      b.classList.add("down");
      press(name);
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, lift);
    b.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (e.repeat) return;
      b.classList.add("down");
      press(name);
    });
    b.addEventListener("keyup", lift);
    b.addEventListener("blur", lift);
    b.addEventListener("click", (e) => e.preventDefault());
  }

  // On the home screen. The browser says when it can install the remote
  // (Chrome and Edge, on a secure origin) and only then does the crawl band
  // grow an INSTALL key; once installed, or opened from the home screen,
  // there is nothing to offer. Safari never asks: the README says Share,
  // Add to Home Screen. The service worker is scoped to the remote alone,
  // so the display and the control room are never served from a cache.
  const install = document.getElementById("install");
  let offer = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    offer = e;
    install.hidden = false;
  });
  install.addEventListener("click", () => {
    if (!offer) return;
    const p = offer;
    offer = null;
    install.hidden = true;
    p.prompt();
  });
  window.addEventListener("appinstalled", () => {
    offer = null;
    install.hidden = true;
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("remote-sw.js", { scope: "remote-control" }).catch(() => { /* http on the LAN: the remote works as a page */ });
  }

  probe();
})();
