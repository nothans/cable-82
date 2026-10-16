#!/usr/bin/env node
// Put Jarvis on CABLE 82.
//
//   node say.mjs "Good evening."
//   node say.mjs --ask weather          (weather, cheerlights, time, joke)
//
// The station's address comes from CABLE82 (default http://cable82.local:1982).
// Node 18 or newer, no packages.

const station = (process.env.CABLE82 || "http://cable82.local:1982").replace(/\/$/, "");

async function call(method, body) {
  let r;
  try {
    r = await fetch(station + "/api/jarvis", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("cannot reach " + station + ": " + (e.cause?.code || e.message));
  }
  if (!r.ok) throw new Error("CABLE 82 said " + r.status + ": " + (await r.text()).trim());
  return r.json();
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node say.mjs "a line"  |  node say.mjs --ask weather');
  process.exit(1);
}
try {
  const about = await call("GET");
  if (!about.enabled) throw new Error(about.name + " is switched off in the control room");
  let said;
  if (args[0] === "--ask") {
    if (!about.asks.includes(args[1])) throw new Error("ask one of: " + about.asks.join(", "));
    said = await call("POST", { ask: args[1] });
  } else {
    said = await call("POST", { text: args.join(" ") });
  }
  const where = said.listeners ? "on " + said.listeners + " set(s)" : "but no set is listening";
  console.log(about.name + " said " + (said.voice ? "out loud" : "on screen") + ", " + where + ": " + said.text);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
