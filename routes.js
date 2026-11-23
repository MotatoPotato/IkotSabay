/* ==========================================================
   routes.js - ROUTE DATA + ETA MATH (single place to update)
   ----------------------------------------------------------
   * Route A (Gate 3 -> Gate 1) and Route B (Gate 1 -> Gate 3)
     are configured SEPARATELY. B is NOT A reversed.
   * Travel times are the verified arithmetic means, in SECONDS,
     between consecutive stops of that route (preliminary data).
   * To update after collecting new observations, edit only the
     segSeconds arrays below. Nothing else needs to change.
   * This file has no DOM code, so the back-end (Node.js) can
     require() the exact same ETA logic.
   ========================================================== */

var STOP_INFO = {
  G3:   { name: "Magdiwang Gate (Gate 3)",          short: "Gate 3" },
  ULS:  { name: "Ugnayang La Salle (ULS)",          short: "ULS" },
  SHS:  { name: "SHS Complex",                      short: "SHS Complex" },
  CBAA: { name: "Gregoria De Jesus Hall (CBAA)",    short: "CBAA" },
  CEAT: { name: "Maria Salome Llanera Hall (CEAT)", short: "CEAT" },
  FS:   { name: "Food Square",                      short: "Food Square" },
  G1:   { name: "Magdalo Gate / Rotunda (Gate 1)",  short: "Gate 1" }
};

/* segSeconds[i] = average seconds from stops[i] to stops[i + 1] */
var ROUTES = {
  A: {
    key: "A",
    label: "Gate 3 → Gate 1",
    stops: ["G3", "ULS", "SHS", "CBAA", "CEAT", "FS", "G1"],
    segSeconds: [45.298, 53.756, 88.558, 54.407, 60.868, 111.274]
  },
  B: {
    key: "B",
    label: "Gate 1 → Gate 3",
    stops: ["G1", "CBAA", "CEAT", "FS", "SHS", "ULS", "G3"],
    segSeconds: [104.657, 33.807, 75.987, 135.605, 49.980, 57.640]
  }
};
var ROUTE_KEYS = ["A", "B"];

/* ---------- derived values (cumulative seconds, total) ---------- */
function roundMs(x) { return Math.round(x * 1000) / 1000; }

ROUTE_KEYS.forEach(function (k) {
  var r = ROUTES[k];
  if (r.segSeconds.length !== r.stops.length - 1) {
    console.error("Route " + k + ": need exactly stops-1 segment times.");
  }
  r.cum = [0];
  for (var i = 0; i < r.segSeconds.length; i++) {
    r.cum.push(roundMs(r.cum[i] + r.segSeconds[i]));
  }
  r.total = r.cum[r.cum.length - 1];
});

/* ---------- location handling ----------
   A jeep location is: route key + stopIndex (last stop reached, index
   in that route's stops array) + secIntoSeg (seconds travelled since
   that stop; 0 = exactly at the stop).
   Returns a cleaned {stopIndex, secIntoSeg} or null if unusable. */
function normalizeLocation(routeKey, stopIndex, secIntoSeg) {
  var r = ROUTES[routeKey];
  if (!r) return null;
  if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= r.stops.length) return null;

  var sec = 0;
  if (secIntoSeg !== undefined && secIntoSeg !== null) {
    sec = Number(secIntoSeg);
    if (!isFinite(sec)) return null;
  }
  if (sec < 0) sec = 0;

  var last = r.stops.length - 1;
  if (stopIndex === last) return { stopIndex: last, secIntoSeg: 0 };

  // travelled the whole segment: the jeep is at the next stop
  if (sec >= r.segSeconds[stopIndex]) return { stopIndex: stopIndex + 1, secIntoSeg: 0 };
  return { stopIndex: stopIndex, secIntoSeg: sec };
}

/* Simulation helper: seconds since the start of a route -> location */
function locationFromElapsed(routeKey, elapsed) {
  var r = ROUTES[routeKey];
  var e = Math.min(Math.max(elapsed, 0), r.total);
  var idx = 0;
  for (var i = 0; i < r.cum.length; i++) {
    if (r.cum[i] <= e) idx = i;
  }
  return normalizeLocation(routeKey, idx, e - r.cum[idx]);
}

/* ---------- ETA ----------
   ETA = sum of the average times of all REMAINING segments between the
   jeep and the target stop, on the jeep's OWN route only.
   Between stops: (rest of the current segment) + later segments.
   Returns one of:
     { status: "ok", seconds: n }   n >= 0
     { status: "passed" }           jeep already went past that stop
     { status: "unknown" }          bad / missing location or stop     */
function etaSeconds(routeKey, stopIndex, secIntoSeg, targetIndex) {
  var r = ROUTES[routeKey];
  if (!r) return { status: "unknown" };
  var loc = normalizeLocation(routeKey, stopIndex, secIntoSeg);
  if (!loc) return { status: "unknown" };
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= r.stops.length) {
    return { status: "unknown" };
  }

  if (targetIndex < loc.stopIndex) return { status: "passed" };
  if (targetIndex === loc.stopIndex) {
    return loc.secIntoSeg === 0 ? { status: "ok", seconds: 0 } : { status: "passed" };
  }

  var remaining = r.segSeconds[loc.stopIndex] - loc.secIntoSeg;
  for (var i = loc.stopIndex + 1; i < targetIndex; i++) remaining += r.segSeconds[i];
  return { status: "ok", seconds: roundMs(Math.max(0, remaining)) };
}

/* Move a location forward by `elapsed` seconds along ONE route. The front-end
   uses this to keep markers moving between server updates. It stops at the
   route's last stop and never switches routes: only the server decides that. */
function advanceWithinRoute(routeKey, stopIndex, secIntoSeg, elapsed) {
  var loc = normalizeLocation(routeKey, stopIndex, secIntoSeg);
  if (!loc) return null;
  var r = ROUTES[routeKey];
  var last = r.stops.length - 1;
  var idx = loc.stopIndex;
  var sec = loc.secIntoSeg + Math.max(0, Number(elapsed) || 0);
  while (idx < last && sec >= r.segSeconds[idx]) { sec -= r.segSeconds[idx]; idx++; }
  if (idx >= last) return { stopIndex: last, secIntoSeg: 0 };
  return { stopIndex: idx, secIntoSeg: roundMs(sec) };
}

/* Soonest in-service jeep on a route that is still heading to a stop.
   Stopped jeeps (breakdown etc.) are skipped.
   jeeps: [{id, label, route, stopIndex, secIntoSeg, active, stopped}] */
function bestEta(jeeps, routeKey, targetIndex) {
  var best = null;
  jeeps.forEach(function (j) {
    if (!j.active || j.stopped || j.route !== routeKey) return;   // a stopped jeep is not approaching anything
    var res = etaSeconds(j.route, j.stopIndex, j.secIntoSeg, targetIndex);
    if (res.status === "ok" && (!best || res.seconds < best.seconds)) {
      best = { jeep: j, seconds: res.seconds };
    }
  });
  return best;
}

/* ---------- display ---------- */
/* 368.863 -> "6 min 9 sec" ; 57.64 -> "58 sec" ; 0 -> "At stop" */
function fmtDuration(sec) {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return "—";
  var total = Math.round(sec);
  if (sec === 0) return "At stop";
  if (total <= 0) return "Arriving now";
  var m = Math.floor(total / 60);
  var s = total % 60;
  if (m === 0) return s + " sec";
  if (s === 0) return m + " min";
  return m + " min " + s + " sec";
}

/* Node.js (back-end / tests) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STOP_INFO: STOP_INFO, ROUTES: ROUTES, ROUTE_KEYS: ROUTE_KEYS,
    normalizeLocation: normalizeLocation, locationFromElapsed: locationFromElapsed,
    advanceWithinRoute: advanceWithinRoute,
    etaSeconds: etaSeconds, bestEta: bestEta, fmtDuration: fmtDuration
  };
}
