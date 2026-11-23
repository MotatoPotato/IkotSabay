/* ==========================================================
   DLSU-D Campus Jeep Tracker - FRONT-END
   Route data and ETA math live in routes.js (load it first).
   Connected to Java back-end at http://localhost:8080/api
   ========================================================== */

var CONFIG = {
  USE_BACKEND: true,                        // Connected to Java server
  API_BASE: "http://localhost:8080/api",    // Java JeepRouteCalculator server URL
  REFRESH_MS: 1000,
  BACKEND_POLL_MS: 5000,
  SERVICE_START: "07:00",                   // first trip (24-hour time)
  SERVICE_END: "16:00",                     // service ends
  /* No jeeps during these breaks. Add more rows if needed. */
  BREAKS: [
    { start: "11:30", end: "13:30", label: "Lunch break" }
  ]
};

/* How much of the drawn path the one-way route uses (the diagram is a
   closed shape; keeping this below 1 stops the first and last stop
   from landing on the same point). Diagram only, not part of the ETA. */
var ROUTE_SPAN = 0.9;

/* ---------- Simulated jeeps (demo only: used when USE_BACKEND is false) ----------
   Each simulated jeep drives Route A, then Route B, then repeats.
   ASSUMPTION (simulation only): it turns around at the terminals with
   NO waiting time, because no dwell-time data has been collected. */
var JEEP_COUNT = 3;
var JEEP_SPACING_SEC = 120;   // each jeep runs 2 minutes behind the previous one
var CYCLE_SEC = ROUTES.A.total + ROUTES.B.total;
var JEEPS_SIM = [];
for (var n = 0; n < JEEP_COUNT; n++) {
  JEEPS_SIM.push({
    id: "J" + (n + 1),
    label: "Jeep " + (n + 1),
    offsetSec: (JEEP_SPACING_SEC * (JEEP_COUNT - 1 - n)) % CYCLE_SEC   // Jeep 1 leads
  });
}

var SVG_NS = "http://www.w3.org/2000/svg";
var selectedRouteKey = "A";
var selectedStopId = ROUTES.A.stops[0];
var backendJeeps = null;
var backendFetchedAt = 0;          // when the last server answer arrived (ms)
var backendState = "connecting";   // "connecting" | "ok" | "down"

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---------- Helpers ---------- */
function secondsNow() {
  var d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}
function toMinutes(hhmm) {
  var p = hhmm.split(":");
  return Number(p[0]) * 60 + Number(p[1]);
}
/* Is the jeep service running right now?
   reason: "demo" | "open" | "before" | "break" | "after" */
function serviceStatus() {
  if ($("demoToggle").checked) return { open: true, reason: "demo" };
  var now = secondsNow() / 60;
  if (now < toMinutes(CONFIG.SERVICE_START)) {
    return { open: false, reason: "before", resume: CONFIG.SERVICE_START };
  }
  if (now >= toMinutes(CONFIG.SERVICE_END)) {
    return { open: false, reason: "after", resume: CONFIG.SERVICE_START };
  }
  for (var i = 0; i < CONFIG.BREAKS.length; i++) {
    var b = CONFIG.BREAKS[i];
    if (now >= toMinutes(b.start) && now < toMinutes(b.end)) {
      return { open: false, reason: "break", label: b.label, from: b.start, resume: b.end };
    }
  }
  return { open: true, reason: "open" };
}
function isActive() { return serviceStatus().open; }

function closedMessage(st) {
  if (st.reason === "break") {
    return st.label + " (" + to12h(st.from) + " - " + to12h(st.resume) +
           "). Jeeps resume at " + to12h(st.resume) + ".";
  }
  if (st.reason === "before") return "Service hasn't started yet. Jeeps start at " + to12h(st.resume) + ".";
  return "Service has ended for today. Jeeps start again at " + to12h(st.resume) + ".";
}
function to12h(hhmm) {
  var p = hhmm.split(":");
  var h = Number(p[0]);
  var m = Number(p[1]);
  var ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
function stopName(id)  { return STOP_INFO[id] ? STOP_INFO[id].name  : id; }
function stopShort(id) { return STOP_INFO[id] ? STOP_INFO[id].short : id; }

/* ---------- Jeep state ----------
   Every jeep becomes: { id, label, route, stopIndex, secIntoSeg, active }
   stopIndex is null when the location is missing or invalid. */
function simulateJeep(j) {
  var p = (secondsNow() + j.offsetSec) % CYCLE_SEC;
  var key = "A";
  if (p >= ROUTES.A.total) { key = "B"; p -= ROUTES.A.total; }
  var loc = locationFromElapsed(key, p);
  return {
    id: j.id, label: j.label, route: key,
    stopIndex: loc.stopIndex, secIntoSeg: loc.secIntoSeg,
    active: isActive()
  };
}

function fromBackend(raw) {
  // Keep the marker moving between server updates (the server answers every few seconds).
  // Falls back to the plain server position if routes.js is an older version.
  var stopped = !!raw.stopped;
  // A stopped jeep does not move: do not interpolate its position.
  var elapsed = stopped ? 0 : (Date.now() - backendFetchedAt) / 1000;
  var loc = (typeof advanceWithinRoute === "function")
    ? advanceWithinRoute(raw.route, raw.stopIndex, raw.secondsIntoSegment, elapsed)
    : normalizeLocation(raw.route, raw.stopIndex, raw.secondsIntoSegment);
  return {
    id: String(raw.id), label: String(raw.label || raw.id), route: raw.route,
    stopIndex: loc ? loc.stopIndex : null,
    secIntoSeg: loc ? loc.secIntoSeg : 0,
    active: !!raw.active && isActive(),   // also respect the service schedule
    stopped: stopped,
    stopReason: String(raw.stopReason || "")
  };
}

function getJeepStates() {
  if (CONFIG.USE_BACKEND) {
    // Real data only. When the server is down we show NO jeeps (never fake ones).
    if (backendState === "ok" && backendJeeps) return backendJeeps.map(fromBackend);
    return [];
  }
  return JEEPS_SIM.map(simulateJeep);
}

/* Message to show instead of jeeps while the server is not answering ("" = fine) */
function backendNotice() {
  if (!CONFIG.USE_BACKEND) return "";
  if (backendState === "connecting") return "Connecting to the server...";
  if (backendState === "down") return "Live data unavailable. The server isn't responding, so no jeep positions can be shown.";
  return "";
}

/* Fetch live jeep data from Java server */
function fetchJeepsFromBackend() {
  return fetch(CONFIG.API_BASE + "/jeeps")
    .then(function (res) {
      if (!res.ok) throw new Error("Server error " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!Array.isArray(data)) throw new Error("Unexpected server answer");
      backendJeeps = data;
      backendFetchedAt = Date.now();
      backendState = "ok";
    })
    .catch(function (err) {
      console.warn("Server unavailable:", err);
      backendJeeps = null;
      backendState = "down";
    })
    .then(function () { render(); });
}

/* ---------- Map ---------- */
function pathPoint(fraction) {
  var path = $("routePath");
  return path.getPointAtLength(fraction * path.getTotalLength());
}

function drawRouteOnMap() {
  var r = ROUTES[selectedRouteKey];
  var layer = $("stopsLayer");
  layer.innerHTML = "";
  var center = { x: 300, y: 200 };

  r.stops.forEach(function (id) {
    var i = r.stops.indexOf(id);
    var pt = pathPoint((r.cum[i] / r.total) * ROUTE_SPAN);

    var g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-stop-id", id);

    var c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", pt.x);
    c.setAttribute("cy", pt.y);
    c.setAttribute("r", 8);
    c.setAttribute("class", "stop-dot");
    c.addEventListener("click", function () { selectStop(id); });

    var dx = pt.x - center.x;
    var dy = pt.y - center.y;
    var horizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
    var t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", "stop-label");
    t.textContent = stopShort(id);
    if (horizontal) {
      t.setAttribute("x", pt.x + (dx > 0 ? 16 : -16));
      t.setAttribute("y", pt.y + 4);
      t.setAttribute("text-anchor", dx > 0 ? "start" : "end");
    } else {
      t.setAttribute("x", pt.x);
      t.setAttribute("y", pt.y + (dy > 0 ? 26 : -16));
      t.setAttribute("text-anchor", "middle");
    }

    g.appendChild(c);
    g.appendChild(t);
    layer.appendChild(g);
  });
  highlightSelectedStop();
  $("mapNote").textContent =
    "Showing Route " + r.key + " (" + r.label + "). Jeeps on the other direction are not drawn.";
}

function highlightSelectedStop() {
  var dots = document.querySelectorAll("#stopsLayer .stop-dot");
  for (var k = 0; k < dots.length; k++) {
    var sid = dots[k].parentNode.getAttribute("data-stop-id");
    if (sid === selectedStopId) { dots[k].classList.add("selected"); }
    else { dots[k].classList.remove("selected"); }
  }
}

function ensureMarker(id) {
  var m = $("marker-" + id);
  if (m) return m;
  m = document.createElementNS(SVG_NS, "g");
  m.setAttribute("class", "jeep");
  m.setAttribute("id", "marker-" + id);
  m.innerHTML =
    '<rect class="jeep-body" x="-14" y="-10" width="28" height="20" rx="6"></rect>' +
    '<text class="jeep-text">' + esc(id) + '</text>';
  $("jeepsLayer").appendChild(m);
  return m;
}

function updateMap(jeeps) {
  var r = ROUTES[selectedRouteKey];
  jeeps.forEach(function (j) {
    var m = ensureMarker(j.id);
    var onRoute = j.route === selectedRouteKey && j.active && j.stopIndex !== null;
    if (!onRoute) { m.style.display = "none"; return; }
    var travelled = r.cum[j.stopIndex] + j.secIntoSeg;
    var pt = pathPoint((travelled / r.total) * ROUTE_SPAN);
    m.setAttribute("transform", "translate(" + pt.x + ", " + pt.y + ")");
    m.style.display = "";
    m.classList.toggle("offline", !!j.stopped);   // greyed out while stopped
  });
}

/* ---------- Selectors ---------- */
function populateRouteSelect() {
  var sel = $("routeSelect");
  sel.innerHTML = ROUTE_KEYS.map(function (k) {
    return '<option value="' + k + '">Route ' + k + ": " + ROUTES[k].label + '</option>';
  }).join("");
  sel.value = selectedRouteKey;
  sel.addEventListener("change", function (e) { selectRoute(e.target.value); });
}

function populateStopSelect() {
  var sel = $("stopSelect");
  var r = ROUTES[selectedRouteKey];
  sel.innerHTML = r.stops.map(function (id) {
    return '<option value="' + id + '">' + esc(stopName(id)) + '</option>';
  }).join("");
  sel.value = selectedStopId;
}

function selectRoute(key) {
  if (!ROUTES[key]) return;
  selectedRouteKey = key;
  $("routeSelect").value = key;
  populateStopSelect();      // same stops, different order on each route
  drawRouteOnMap();
  render();
}

function selectStop(id) {
  selectedStopId = id;
  $("stopSelect").value = id;
  highlightSelectedStop();
  render();
}

/* ---------- Rendering ---------- */
function etaText(seconds) {
  return seconds === 0 ? "At this stop" : fmtDuration(seconds);
}

function renderFinder(jeeps) {
  var r = ROUTES[selectedRouteKey];
  var idx = r.stops.indexOf(selectedStopId);
  var el = $("finderResult");

  var notice = backendNotice();
  if (notice) {
    el.innerHTML = '<span class="muted">' + esc(notice) + '</span>';
    return;
  }
  var onRoute = jeeps.filter(function (j) { return j.active && j.route === selectedRouteKey; });
  if (!jeeps.some(function (j) { return j.active; })) {
    var st = serviceStatus();
    el.innerHTML = '<span class="muted">' +
      (st.open ? "No jeeps are in service right now." : esc(closedMessage(st))) + '</span>';
    return;
  }
  if (onRoute.length === 0) {
    el.innerHTML = '<span class="muted">No jeep is currently running on this route.</span>';
    return;
  }
  var best = bestEta(jeeps, selectedRouteKey, idx);
  var stoppedOnRoute = onRoute.filter(function (j) { return j.stopped; });
  if (!best && stoppedOnRoute.length > 0 && stoppedOnRoute.length === onRoute.length) {
    el.innerHTML = '<span class="muted">' + esc(stoppedOnRoute[0].label) + ' is stopped (' +
      esc(stoppedOnRoute[0].stopReason || "problem on the road") +
      '). No jeep is moving on this route right now.</span>';
    return;
  }
  if (!best) {
    var why = idx === 0
      ? 'This is the <b>first stop</b> of Route ' + r.key + ' (' + esc(r.label) + '). A jeep only counts here once it has started this route. Try another stop or the other direction.'
      : 'Every jeep on Route ' + r.key + ' has already passed this stop. Try the other direction or a later stop.';
    el.innerHTML = '<span class="muted">' + why + '</span>';
    return;
  }
  el.innerHTML = 'Next jeep: <strong>' + esc(best.jeep.label) + '</strong> ' +
    (best.seconds === 0 ? 'is <strong>at this stop</strong>'
                        : 'arriving in <strong>' + fmtDuration(best.seconds) + '</strong>');
}

function renderJeepCards(jeeps) {
  var st = serviceStatus();
  if (jeeps.length === 0) {
    $("jeepCards").innerHTML = '<p class="muted">' +
      esc(backendNotice() || "No jeeps are on the road yet.") + '</p>';
    return;
  }
  $("jeepCards").innerHTML = jeeps.map(function (j) {
    var r = ROUTES[j.route];
    var body;
    if (!j.active) {
      body = '<p>' + (st.open ? "Not in service." : esc(closedMessage(st))) + '</p>';
    } else if (!r || j.stopIndex === null) {
      body = '<p>Location unavailable.</p>';
    } else {
      var last = j.stopIndex >= r.stops.length - 1;
      var atStop = j.secIntoSeg === 0;
      var pct = ((r.cum[j.stopIndex] + j.secIntoSeg) / r.total) * 100;
      body = '<p>Route ' + r.key + ': <b>' + esc(r.label) + '</b></p>';
      if (j.stopped) {
        body += '<p class="stopped-note">Stopped: ' + esc(j.stopReason || "problem on the road") + '</p>' +
                '<p>Near <b>' + esc(stopName(r.stops[j.stopIndex])) + '</b>' +
                (last ? '' : ' (heading to ' + esc(stopName(r.stops[j.stopIndex + 1])) + ')') + '</p>' +
                '<p class="muted">Not counted in arrival estimates.</p>';
      } else if (last) {
        body += '<p>Reached <b>' + esc(stopName(r.stops[j.stopIndex])) + '</b> (end of route)</p>';
      } else {
        var next = r.stops[j.stopIndex + 1];
        var res = etaSeconds(j.route, j.stopIndex, j.secIntoSeg, j.stopIndex + 1);
        if (atStop) body += '<p>Now at <b>' + esc(stopName(r.stops[j.stopIndex])) + '</b></p>';
        body += '<p>Heading to: <b>' + esc(stopName(next)) + '</b></p>' +
                '<p>Arrives in: <b>' + fmtDuration(res.seconds) + '</b></p>';
      }
      body += '<div class="progress"><div style="width:' + pct.toFixed(1) + '%"></div></div>';
    }
    return '<div class="jeep-card">' +
      '<h4>' + esc(j.label) + ' <span class="badge ' + (j.stopped ? "stopped" : (j.active ? "" : "off")) + '">' +
      (j.stopped ? "Stopped" : (j.active ? "In service" : (st.reason === "break" ? esc(st.label) : "Off duty"))) +
      '</span></h4>' + body + '</div>';
  }).join("");
}

function renderTimetable(jeeps) {
  var r = ROUTES[selectedRouteKey];
  $("timetableRoute").textContent = "Route " + r.key + ": " + r.label;
  $("timetableBody").innerHTML = r.stops.map(function (id, i) {
    var best = bestEta(jeeps, selectedRouteKey, i);
    return '<tr class="' + (id === selectedStopId ? "selected" : "") + '">' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + esc(stopName(id)) + '</td>' +
      '<td>' + (i === 0 ? "—" : fmtDuration(r.segSeconds[i - 1])) + '</td>' +
      '<td>' + (i === 0 ? "Start" : fmtDuration(r.cum[i])) + '</td>' +
      '<td class="eta">' + (best ? etaText(best.seconds) + ' (' + esc(best.jeep.id) + ')' : "—") + '</td>' +
      '</tr>';
  }).join("");
}

function render() {
  var jeeps = getJeepStates();
  updateMap(jeeps);
  renderFinder(jeeps);
  renderJeepCards(jeeps);
  renderTimetable(jeeps);
  $("clock").textContent = new Date().toLocaleTimeString();
}

/* ---------- Full-screen map viewer ---------- */
function initLightbox() {
  var box = $("lightbox");
  var thumb = $("mapThumb");
  var closeBtn = $("lightboxClose");

  function openBox() {
    box.classList.add("open");
    box.setAttribute("aria-hidden", "false");
    document.body.classList.add("no-scroll");
  }
  function closeBox() {
    box.classList.remove("open");
    box.setAttribute("aria-hidden", "true");
    document.body.classList.remove("no-scroll");
  }

  thumb.addEventListener("click", openBox);
  closeBtn.addEventListener("click", closeBox);

  // tapping the dark area outside the photo closes it
  box.addEventListener("click", function (e) {
    if (e.target !== $("lightboxImg")) closeBox();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeBox();
  });
}

/* ---------- Init ---------- */
function init() {
  $("year").textContent = new Date().getFullYear();
  $("serviceHours").textContent =
    to12h(CONFIG.SERVICE_START) + " - " + to12h(CONFIG.SERVICE_END) +
    CONFIG.BREAKS.map(function (b) {
      return "; no jeeps " + to12h(b.start) + " - " + to12h(b.end) + " (" + b.label.toLowerCase() + ")";
    }).join("");

  populateRouteSelect();
  populateStopSelect();
  $("stopSelect").addEventListener("change", function (e) { selectStop(e.target.value); });
  drawRouteOnMap();
  initLightbox();
  $("demoToggle").addEventListener("change", render);
  render();
  setInterval(render, CONFIG.REFRESH_MS);

  // Poll the Java server for real jeep data
  if (CONFIG.USE_BACKEND) {
    fetchJeepsFromBackend();
    setInterval(fetchJeepsFromBackend, CONFIG.BACKEND_POLL_MS);
  }
}

document.addEventListener("DOMContentLoaded", init);
