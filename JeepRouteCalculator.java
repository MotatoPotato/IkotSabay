import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * Ikot Sabay back-end.
 *
 * Run:        java JeepRouteCalculator            (real schedule: 7:00 AM - 4:00 PM, no jeeps 11:30 AM - 1:30 PM)
 *             java JeepRouteCalculator --demo     (ignores the schedule, handy for testing at any hour)
 *             java JeepRouteCalculator --test     (checks the ETA numbers and the schedule, then exits)
 *
 * Endpoints:  GET  /api/jeeps               jeeps that are on the road (add ?all=1 to list every registered jeep)
 *             POST /api/trips/start         {"jeepId":"J1","route":"A"}    route is optional (default "A")
 *             POST /api/trips/end           {"jeepId":"J1"}
 *             POST /api/trips/checkin       {"jeepId":"J1","stopIndex":3}  driver reached that stop of the jeep's current route
 *
 * Every start / end / check-in is appended to events.csv (the real data you can use to check accuracy later).
 */
public class JeepRouteCalculator {

    // ---------- Settings ----------
    static final ZoneId ZONE = ZoneId.of("Asia/Manila");        // schedule uses Philippine time, whatever the server's clock says
    static final LocalTime SERVICE_START = LocalTime.of(7, 0);
    static final LocalTime SERVICE_END = LocalTime.of(16, 0);
    static final LocalTime[][] BREAKS = { { LocalTime.of(11, 30), LocalTime.of(13, 30) } };   // lunch break
    static boolean enforceSchedule = true;                       // --demo turns this off
    static final Path EVENT_LOG = Paths.get("events.csv");
    static final String CLOSED_MSG =
        "Service is closed right now. Jeeps run 7:00 AM to 4:00 PM, with no jeeps from 11:30 AM to 1:30 PM.";

    /** Is the jeep service running at this time of day? (propositional logic: p AND q AND NOT r) */
    public static boolean serviceOpen(LocalTime t) {
        if (t.isBefore(SERVICE_START) || !t.isBefore(SERVICE_END)) return false;
        for (LocalTime[] b : BREAKS) {
            if (!t.isBefore(b[0]) && t.isBefore(b[1])) return false;
        }
        return true;
    }

    // ---------- Stops and routes (same numbers as routes.js) ----------
    public static final Map<String, String> STOP_NAMES = Map.of(
        "G3", "Magdiwang Gate (Gate 3)",
        "ULS", "Ugnayang La Salle (ULS)",
        "SHS", "SHS Complex",
        "CBAA", "Gregoria De Jesus Hall (CBAA)",
        "CEAT", "Maria Salome Llanera Hall (CEAT)",
        "FS", "Food Square",
        "G1", "Magdalo Gate / Rotunda (Gate 1)"
    );

    public static class RouteInfo {
        String key;
        String label;
        List<String> stops;
        double[] segSeconds;
        double[] cumSeconds;
        double totalTime;

        public RouteInfo(String key, String label, List<String> stops, double[] segSeconds) {
            this.key = key;
            this.label = label;
            this.stops = stops;
            this.segSeconds = segSeconds;

            this.cumSeconds = new double[stops.size()];
            this.cumSeconds[0] = 0.0;
            double sum = 0.0;
            for (int i = 0; i < segSeconds.length; i++) {
                sum += segSeconds[i];
                this.cumSeconds[i + 1] = sum;
            }
            this.totalTime = sum;
        }
    }

    public static final Map<String, RouteInfo> ROUTES = Map.of(
        "A", new RouteInfo("A", "Gate 3 → Gate 1",
            List.of("G3", "ULS", "SHS", "CBAA", "CEAT", "FS", "G1"),
            new double[]{45.298, 53.756, 88.558, 54.407, 60.868, 111.274}
        ),
        "B", new RouteInfo("B", "Gate 1 → Gate 3",
            List.of("G1", "CBAA", "CEAT", "FS", "SHS", "ULS", "G3"),
            new double[]{104.657, 33.807, 75.987, 135.605, 49.980, 57.640}
        )
    );

    // ---------- ETA ----------
    public static class EtaResult {
        public final String status; // "ok", "passed", or "unknown"
        public final double seconds;

        public EtaResult(String status, double seconds) {
            this.status = status;
            this.seconds = seconds;
        }
    }

    /** ETA = sum of the average times of the remaining segments, on this jeep's own route only. */
    public static EtaResult calculateEta(String routeKey, int stopIndex, double secIntoSeg, int targetIndex) {
        RouteInfo r = ROUTES.get(routeKey);
        if (r == null || stopIndex < 0 || stopIndex >= r.stops.size() || targetIndex < 0 || targetIndex >= r.stops.size()) {
            return new EtaResult("unknown", 0);
        }
        if (targetIndex < stopIndex) return new EtaResult("passed", 0);
        if (targetIndex == stopIndex) {
            return secIntoSeg == 0 ? new EtaResult("ok", 0) : new EtaResult("passed", 0);
        }
        double remaining = r.segSeconds[stopIndex] - secIntoSeg;
        for (int i = stopIndex + 1; i < targetIndex; i++) {
            remaining += r.segSeconds[i];
        }
        return new EtaResult("ok", Math.max(0, remaining));
    }

    public static String formatDuration(double sec) {
        if (sec <= 0) return "At stop / Arriving now";
        int total = (int) Math.round(sec);
        int m = total / 60;
        int s = total % 60;
        if (m == 0) return s + " sec";
        if (s == 0) return m + " min";
        return m + " min " + s + " sec";
    }

    // ---------- Jeeps ----------
    public static class JeepUnit {
        public final String id;
        public final String label;
        public String route = "A";
        public int stopIndex = 0;
        public double secondsIntoSegment = 0.0;
        public boolean active = false;          // a jeep is NOT on the road until its driver starts a trip

        public JeepUnit(String id, String label) {
            this.id = id;
            this.label = label;
        }

        void start(String routeKey) {
            route = routeKey;
            stopIndex = 0;
            secondsIntoSegment = 0.0;
            active = true;
        }

        void stop() {
            active = false;
            route = "A";
            stopIndex = 0;
            secondsIntoSegment = 0.0;
        }

        public void advance(double elapsedSeconds) {
            if (!active || elapsedSeconds <= 0) return;

            double remainingDelta = elapsedSeconds;
            while (remainingDelta > 0) {
                RouteInfo r = ROUTES.get(route);
                if (r == null) break;

                int lastStop = r.stops.size() - 1;
                if (stopIndex >= lastStop) {
                    // Reached the end: continue on the other direction (no waiting time, none was measured)
                    route = "A".equals(route) ? "B" : "A";
                    stopIndex = 0;
                    secondsIntoSegment = 0.0;
                    continue;
                }

                double segLen = r.segSeconds[stopIndex];
                double timeLeftInSeg = segLen - secondsIntoSegment;

                if (remainingDelta < timeLeftInSeg) {
                    secondsIntoSegment += remainingDelta;
                    remainingDelta = 0;
                } else {
                    remainingDelta -= timeLeftInSeg;
                    stopIndex++;
                    secondsIntoSegment = 0.0;
                }
            }
        }

        public String toJson() {
            return String.format(Locale.US,
                "{\"id\":\"%s\",\"label\":\"%s\",\"route\":\"%s\",\"stopIndex\":%d,\"secondsIntoSegment\":%.3f,\"active\":%s}",
                escapeJson(id), escapeJson(label), escapeJson(route), stopIndex, secondsIntoSegment, active
            );
        }
    }

    // Registered jeeps. They all start OFF the road.
    private static final Object LOCK = new Object();
    private static final List<JeepUnit> JEEPS = new ArrayList<>(List.of(
        new JeepUnit("J1", "Jeep 1"),
        new JeepUnit("J2", "Jeep 2"),
        new JeepUnit("J3", "Jeep 3")
    ));
    private static long lastTickMillis = System.currentTimeMillis();

    private static JeepUnit findJeep(String id) {
        for (JeepUnit j : JEEPS) {
            if (j.id.equalsIgnoreCase(id)) return j;
        }
        return null;
    }

    /** Moves every running jeep forward. Ends all trips when the service closes (end of day or lunch). Call inside LOCK. */
    private static void tickFleet() {
        long now = System.currentTimeMillis();
        double deltaSec = (now - lastTickMillis) / 1000.0;
        lastTickMillis = now;

        boolean closed = enforceSchedule && !serviceOpen(LocalTime.now(ZONE));
        for (JeepUnit j : JEEPS) {
            if (!j.active) continue;
            if (closed) {
                logEvent("AUTO_END_SCHEDULE", j);
                j.stop();
            } else {
                j.advance(deltaSec);
            }
        }
    }

    private static String fleetToJson(boolean all) {
        synchronized (LOCK) {
            tickFleet();
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (JeepUnit j : JEEPS) {
                if (!all && !j.active) continue;
                if (!first) sb.append(",");
                sb.append(j.toJson());
                first = false;
            }
            return sb.append("]").toString();
        }
    }

    // ---------- Event log (events.csv) ----------
    private static void logEvent(String event, JeepUnit j) {
        String line = String.join(",",
            OffsetDateTime.now(ZONE).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            event, j.id, j.route, String.valueOf(j.stopIndex),
            String.format(Locale.US, "%.3f", j.secondsIntoSegment)) + "\n";
        try {
            if (!Files.exists(EVENT_LOG)) {
                Files.writeString(EVENT_LOG, "timestamp,event,jeepId,route,stopIndex,secondsIntoSegment\n");
            }
            Files.writeString(EVENT_LOG, line, StandardOpenOption.APPEND);
        } catch (IOException e) {
            System.err.println("Could not write events.csv: " + e.getMessage());
        }
    }

    // ---------- Actions ----------
    private static Response startTrip(String jeepId, String route) {
        if (jeepId.isEmpty()) return error(400, "jeepId is required");
        if (route.isEmpty()) route = "A";
        if (!ROUTES.containsKey(route)) return error(400, "route must be \"A\" or \"B\"");
        synchronized (LOCK) {
            tickFleet();
            JeepUnit j = findJeep(jeepId);
            if (j == null) return error(404, "Unknown jeep: " + jeepId);
            if (enforceSchedule && !serviceOpen(LocalTime.now(ZONE))) return error(409, CLOSED_MSG);
            if (j.active) {
                // Pressing Yes again must NOT send a running jeep back to the start
                return new Response(200, "{\"ok\":true,\"alreadyRunning\":true,\"jeepId\":\"" + escapeJson(j.id) + "\"}");
            }
            j.start(route);
            logEvent("START", j);
            return new Response(200, "{\"ok\":true,\"jeepId\":\"" + escapeJson(j.id) + "\"}");
        }
    }

    private static Response endTrip(String jeepId) {
        if (jeepId.isEmpty()) return error(400, "jeepId is required");
        synchronized (LOCK) {
            tickFleet();
            JeepUnit j = findJeep(jeepId);
            if (j == null) return error(404, "Unknown jeep: " + jeepId);
            if (!j.active) {
                return new Response(200, "{\"ok\":true,\"alreadyEnded\":true,\"jeepId\":\"" + escapeJson(j.id) + "\"}");
            }
            logEvent("END", j);
            j.stop();
            return new Response(200, "{\"ok\":true,\"jeepId\":\"" + escapeJson(j.id) + "\"}");
        }
    }

    /** The driver reports "I am at stop number N of my current route". This corrects any drift from the averages. */
    private static Response checkIn(String jeepId, Integer stopIndex) {
        if (jeepId.isEmpty()) return error(400, "jeepId is required");
        if (stopIndex == null) return error(400, "stopIndex is required");
        synchronized (LOCK) {
            tickFleet();
            JeepUnit j = findJeep(jeepId);
            if (j == null) return error(404, "Unknown jeep: " + jeepId);
            if (!j.active) return error(409, "This jeep has not started a trip");
            RouteInfo r = ROUTES.get(j.route);
            if (stopIndex < 0 || stopIndex >= r.stops.size()) {
                return error(400, "stopIndex must be between 0 and " + (r.stops.size() - 1) + " for route " + j.route);
            }
            // Going backwards is allowed on purpose: a slow jeep may be behind where the averages say it should be
            j.stopIndex = stopIndex;
            j.secondsIntoSegment = 0.0;
            logEvent("CHECKIN", j);
            return new Response(200, "{\"ok\":true,\"jeepId\":\"" + escapeJson(j.id) + "\",\"route\":\"" + j.route
                + "\",\"stopIndex\":" + stopIndex + "}");
        }
    }

    // ---------- HTTP plumbing ----------
    static class Response {
        final int status;
        final String json;
        Response(int status, String json) { this.status = status; this.json = json; }
    }

    private interface Handler {
        Response handle(HttpExchange exchange, String body) throws Exception;
    }

    private static Response error(int status, String message) {
        return new Response(status, "{\"error\":\"" + escapeJson(message) + "\"}");
    }

    private static void api(HttpServer server, String path, String method, Handler handler) {
        server.createContext(path, exchange -> {
            try {
                addCorsHeaders(exchange);
                if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                    exchange.sendResponseHeaders(204, -1);
                    return;
                }
                if (!method.equalsIgnoreCase(exchange.getRequestMethod())) {
                    sendJson(exchange, 405, error(405, "Method not allowed").json);
                    return;
                }
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                Response r = handler.handle(exchange, body);
                sendJson(exchange, r.status, r.json);
            } catch (Exception e) {
                e.printStackTrace();
                try { sendJson(exchange, 500, error(500, "Server error").json); } catch (IOException ignored) { }
            } finally {
                exchange.close();
            }
        });
    }

    public static void startServer(int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        api(server, "/api/jeeps", "GET", (ex, body) -> {
            String q = ex.getRequestURI().getQuery();
            boolean all = q != null && q.contains("all=1");
            return new Response(200, fleetToJson(all));
        });

        api(server, "/api/trips/start", "POST", (ex, body) ->
            startTrip(extractJsonString(body, "jeepId"), extractJsonString(body, "route")));

        api(server, "/api/trips/end", "POST", (ex, body) ->
            endTrip(extractJsonString(body, "jeepId")));

        api(server, "/api/trips/checkin", "POST", (ex, body) ->
            checkIn(extractJsonString(body, "jeepId"), extractJsonInt(body, "stopIndex")));

        server.setExecutor(null);
        server.start();
        System.out.println("Backend server running on http://localhost:" + port + "/api/jeeps");
        System.out.println(enforceSchedule
            ? "Schedule ON: 7:00 AM - 4:00 PM (Philippine time), no jeeps 11:30 AM - 1:30 PM."
            : "DEMO mode: schedule is ignored.");
    }

    private static void addCorsHeaders(HttpExchange exchange) {
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static void sendJson(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static String extractJsonString(String json, String key) {
        String token = "\"" + key + "\"";
        int keyIdx = json.indexOf(token);
        if (keyIdx == -1) return "";
        int colonIdx = json.indexOf(":", keyIdx + token.length());
        if (colonIdx == -1) return "";
        int startQuote = json.indexOf("\"", colonIdx + 1);
        int endQuote = json.indexOf("\"", startQuote + 1);
        if (startQuote == -1 || endQuote == -1) return "";
        return json.substring(startQuote + 1, endQuote);
    }

    private static Integer extractJsonInt(String json, String key) {
        String token = "\"" + key + "\"";
        int keyIdx = json.indexOf(token);
        if (keyIdx == -1) return null;
        int colonIdx = json.indexOf(":", keyIdx + token.length());
        if (colonIdx == -1) return null;
        int i = colonIdx + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int start = i;
        if (i < json.length() && json.charAt(i) == '-') i++;
        while (i < json.length() && Character.isDigit(json.charAt(i))) i++;
        try {
            return Integer.valueOf(json.substring(start, i));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    // ---------- Self-test: java JeepRouteCalculator --test ----------
    private static int failures = 0;

    private static void check(String name, double actual, double expected) {
        boolean ok = Math.abs(actual - expected) < 0.0005;
        if (!ok) failures++;
        System.out.println((ok ? "PASS  " : "FAIL  ") + name + "  got " + actual + "  expected " + expected);
    }

    private static void checkBool(String name, boolean actual, boolean expected) {
        boolean ok = actual == expected;
        if (!ok) failures++;
        System.out.println((ok ? "PASS  " : "FAIL  ") + name + "  got " + actual + "  expected " + expected);
    }

    private static double eta(String route, String from, String to) {
        List<String> stops = ROUTES.get(route).stops;
        EtaResult r = calculateEta(route, stops.indexOf(from), 0, stops.indexOf(to));
        return r.status.equals("ok") ? r.seconds : -1;
    }

    private static int runSelfTest() {
        check("A: ULS -> Gate 1", eta("A", "ULS", "G1"), 368.863);
        check("A: Food Square -> Gate 1", eta("A", "FS", "G1"), 111.274);
        check("B: CBAA -> Gate 3", eta("B", "CBAA", "G3"), 353.019);
        check("B: SHS Complex -> Gate 3", eta("B", "SHS", "G3"), 107.620);
        check("B: ULS -> Gate 3", eta("B", "ULS", "G3"), 57.640);
        check("Route A total", ROUTES.get("A").totalTime, 414.161);
        checkBool("passed stop gives status passed", calculateEta("A", 4, 0, 1).status.equals("passed"), true);
        checkBool("bad route gives status unknown", calculateEta("Z", 0, 0, 1).status.equals("unknown"), true);
        checkBool("06:59 closed", serviceOpen(LocalTime.of(6, 59)), false);
        checkBool("07:00 open", serviceOpen(LocalTime.of(7, 0)), true);
        checkBool("11:29 open", serviceOpen(LocalTime.of(11, 29)), true);
        checkBool("11:30 closed (lunch)", serviceOpen(LocalTime.of(11, 30)), false);
        checkBool("13:29 closed (lunch)", serviceOpen(LocalTime.of(13, 29)), false);
        checkBool("13:30 open", serviceOpen(LocalTime.of(13, 30)), true);
        checkBool("15:59 open", serviceOpen(LocalTime.of(15, 59)), true);
        checkBool("16:00 closed", serviceOpen(LocalTime.of(16, 0)), false);
        System.out.println(failures == 0 ? "\nALL TESTS PASSED" : "\n" + failures + " TEST(S) FAILED");
        return failures;
    }

    public static void main(String[] args) throws Exception {
        List<String> a = Arrays.asList(args);
        if (a.contains("--test")) {
            System.exit(runSelfTest() == 0 ? 0 : 1);
        }
        if (a.contains("--demo")) enforceSchedule = false;
        startServer(8080);
    }
}
