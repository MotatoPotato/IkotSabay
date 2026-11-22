/* ==========================================================
   Home page: role check + Tsuper banner
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

  // "Yes" button: start the trip on the Java back-end
  var startBtn = document.getElementById("startTripBtn");
  var msg = document.getElementById("tripMsg");

  startBtn.addEventListener("click", function () {
    startBtn.disabled = true;   // stops accidental double taps while the request is running
    msg.textContent = "Starting your trip...";
    // Uses the same server address as script.js (CONFIG.API_BASE)
    var apiBase = (typeof CONFIG !== "undefined" && CONFIG.API_BASE) ? CONFIG.API_BASE : "http://localhost:8080/api";
    fetch(apiBase + "/trips/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jeepId: jeepId })
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Server error " + res.status);
        return res.json();
      })
      .then(function () {
        startBtn.textContent = "Trip started";
        msg.textContent = "Trip started on server for " + jeepId + ".";
        if (typeof fetchJeepsFromBackend === "function") fetchJeepsFromBackend();   // refresh the map right away
      })
      .catch(function (err) {
        console.warn("Failed to reach Java server:", err);
        startBtn.disabled = false;   // let the driver try again
        msg.textContent = "Could not reach the Java server on port 8080.";
      });
  });

  // Log out: clear the session and go back to the role page
  document.getElementById("logoutBtn").addEventListener("click", function () {
    try { sessionStorage.clear(); } catch (e) {}
    window.location.href = "index.html";
  });
})();
