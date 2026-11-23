/* ==========================================================
   Home page: role check + Tsuper banner
   Buttons: Yes (start trip) -> Stop (breakdown etc.) -> Resume trip
   The server is the source of truth; this page re-checks it every 5 s.
   ========================================================== */
(function () {
  var role = null;
  var jeepNo = null;
  var jeepId = null;

  try {
    role = sessionStorage.getItem("role");
    jeepNo = sessionStorage.getItem("jeepNo");
    jeepId = sessionStorage.getItem("jeepId");
  } catch (e) {
    role = "student";   // storage blocked: just show the student view
  }

  // No role chosen yet: go to the role page
  if (!role) {
    window.location.replace("index.html");
    return;
  }

  // Students see the normal page
  if (role !== "tsuper") return;

  // Tsuper: show the banner
  var bar = document.getElementById("driverBar");
  document.getElementById("driverJeep").textContent = "Jeep " + jeepNo;
  bar.hidden = false;

  var askEl = bar.querySelector(".driver-ask");
  var startBtn = document.getElementById("startTripBtn");
  var stopBtn = document.getElementById("stopTripBtn");
  var resumeBtn = document.getElementById("resumeTripBtn");
  var reasonSel = document.getElementById("stopReason");
  var msg = document.getElementById("tripMsg");

  function apiBase() {
    // Same server address as script.js (CONFIG.API_BASE)
    return (typeof CONFIG !== "undefined" && CONFIG.API_BASE) ? CONFIG.API_BASE : "http://localhost:8080/api";
  }

  function post(path) {
    var payload = { jeepId: jeepId };
    if (path === "/trips/stop") payload.reason = reasonSel.value;
    return fetch(apiBase() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) {
        // The server explains why it refused (e.g. "Service is closed right now...")
        return res.json().catch(function () { return {}; }).then(function (b) {
          var e = new Error("Server error " + res.status);
          e.serverMessage = b.error || "";
          throw e;
        });
      }
      return res.json();
    });
  }

  function refreshMap() {
    if (typeof fetchJeepsFromBackend === "function") fetchJeepsFromBackend();
  }

  /* mode: "idle" (no trip) | "running" | "stopped" */
  function setEl(el, hidden) { if (el) { el.hidden = hidden; el.disabled = false; } }

  function showMode(mode, reason) {
    // setEl skips missing elements, so an old home.html can't break the Yes button
    setEl(startBtn, mode !== "idle");
    setEl(stopBtn, mode !== "running");
    setEl(reasonSel, mode !== "running");
    setEl(resumeBtn, mode !== "stopped");
    if (mode === "idle") {
      askEl.textContent = "Ready to start your trip with Lasallian?";
      startBtn.textContent = "Yes";
    } else if (mode === "running") {
      askEl.textContent = "Your trip is running. Press Stop if the jeep has a problem.";
    } else {
      askEl.textContent = "Your jeep is stopped" + (reason ? " (" + reason + ")" : "") +
        ". Press Resume trip when you are moving again.";
    }
  }

  function fail(btn, err) {
    console.warn("Failed to reach Java server:", err);
    btn.disabled = false;   // let the driver try again
    msg.textContent = err.serverMessage || "Could not reach the Java server on port 8080.";
  }

  // Ask the server what this jeep is doing and show the right buttons
  function sync() {
    fetch(apiBase() + "/jeeps?all=1")
      .then(function (res) { return res.json(); })
      .then(function (list) {
        var me = null;
        (list || []).forEach(function (j) { if (String(j.id) === String(jeepId)) me = j; });
        if (!me || !me.active) showMode("idle");
        else if (me.stopped) showMode("stopped", me.stopReason);
        else showMode("running");
      })
      .catch(function () { /* server down: keep whatever is showing */ });
  }

  startBtn.addEventListener("click", function () {
    startBtn.disabled = true;   // stops accidental double taps while the request is running
    msg.textContent = "Starting your trip...";
    post("/trips/start")
      .then(function (data) {
        msg.textContent = (data && data.alreadyRunning)
          ? "Your trip is already running."
          : "Trip started on server for " + jeepId + ".";
        showMode("running");
        refreshMap();
      })
      .catch(function (err) { fail(startBtn, err); });
  });

  if (stopBtn) stopBtn.addEventListener("click", function () {
    // Confirm first so nobody stops the jeep by an accidental tap
    if (!reasonSel) return;
    if (!window.confirm("Stop your trip? Students will see that " + (jeepNo ? "Jeep " + jeepNo : "your jeep") +
      " is stopped (" + reasonSel.value + ") and it will not be counted in arrival estimates.")) return;
    stopBtn.disabled = true;
    var reason = reasonSel.value;
    msg.textContent = "Reporting the problem...";
    post("/trips/stop")
      .then(function () {
        msg.textContent = "Marked as stopped. Students can see this now.";
        showMode("stopped", reason);
        refreshMap();
      })
      .catch(function (err) { fail(stopBtn, err); });
  });

  if (resumeBtn) resumeBtn.addEventListener("click", function () {
    resumeBtn.disabled = true;
    msg.textContent = "Resuming your trip...";
    post("/trips/resume")
      .then(function () {
        msg.textContent = "Trip resumed.";
        showMode("running");
        refreshMap();
      })
      .catch(function (err) { fail(resumeBtn, err); });
  });

  // Log out: clear the session and go back to the role page
  document.getElementById("logoutBtn").addEventListener("click", function () {
    try { sessionStorage.clear(); } catch (e) {}
    window.location.href = "index.html";
  });

  showMode("idle");
  sync();
  setInterval(sync, 5000);
})();
