import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class JeepRouteCalculator {

    // Stop Information Mapping
    public static final Map<String, String> STOP_NAMES = Map.of(
        "G3", "Magdiwang Gate (Gate 3)",
        "ULS", "Ugnayang La Salle (ULS)",
        "SHS", "SHS Complex",
        "CBAA", "Gregoria De Jesus Hall (CBAA)",
        "CEAT", "Maria Salome Llanera Hall (CEAT)",
        "FS", "Food Square",
        "G1", "Magdalo Gate / Rotunda (Gate 1)"
    );

    // Route Data structure
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

    // Result object for ETA calculations
    public static class EtaResult {
        public final String status; // "ok", "passed", or "unknown"
        public final double seconds;

        public EtaResult(String status, double seconds) {
            this.status = status;
            this.seconds = seconds;
        }
    }

    // Live Jeep object expected by script_Esmar.js (/api/jeeps)
    public static class JeepUnit {
        public final String id;
        public final String label;
        public String route;
        public int stopIndex;
        public double secondsIntoSegment;
        public boolean active;

        public JeepUnit(String id, String label, String route, int stopIndex, double secondsIntoSegment, boolean active) {
            this.id = id;
            this.label = label;
            this.route = route;
            this.stopIndex = stopIndex;
            this.secondsIntoSegment = secondsIntoSegment;
            this.active = active;
        }

        public void advance(double elapsedSeconds) {
            if (!active || elapsedSeconds <= 0) return;

            double remainingDelta = elapsedSeconds;
            while (remainingDelta > 0) {
                RouteInfo r = ROUTES.get(route);
                if (r == null) break;

                int lastStop = r.stops.size() - 1;
                if (stopIndex >= lastStop) {
                    // Switch from Route A to Route B (or loop back to A)
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

    // Fleet initialized with staggered positions on Route A and Route B
    private static final List<JeepUnit> JEEPS = Collections.synchronizedList(new ArrayList<>(List.of(
        new JeepUnit("J1", "Jeep 1", "A", 1, 10.0, true),
        new JeepUnit("J2", "Jeep 2", "A", 0, 0.0, true),
        new JeepUnit("J3", "Jeep 3", "B", 2, 15.0, true)
    )));

    private static long lastTickMillis = System.currentTimeMillis();

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

    private static void tickFleet() {
        synchronized (JEEPS) {
            long now = System.currentTimeMillis();
            double deltaSec = (now - lastTickMillis) / 1000.0;
            lastTickMillis = now;
            for (JeepUnit j : JEEPS) {
                j.advance(deltaSec);
            }
        }
    }

    private static String fleetToJson() {
        tickFleet();
        synchronized (JEEPS) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < JEEPS.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(JEEPS.get(i).toJson());
            }
            sb.append("]");
            return sb.toString();
        }
    }

    private static void startTripForJeep(String jeepId) {
        tickFleet();
        synchronized (JEEPS) {
            for (JeepUnit j : JEEPS) {
                if (j.id.equalsIgnoreCase(jeepId)) {
                    j.active = true;
                    j.route = "A";
                    j.stopIndex = 0;
                    j.secondsIntoSegment = 0.0;
                }
            }
        }
    }

    public static void startServer(int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        // GET /api/jeeps -> polled by script_Esmar.js
        server.createContext("/api/jeeps", exchange -> {
            addCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            sendJson(exchange, 200, fleetToJson());
        });

        // POST /api/trips/start -> triggered by driver_esmar.js when "Yes" is clicked
        server.createContext("/api/trips/start", exchange -> {
            addCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String jeepId = extractJsonString(body, "jeepId");
            startTripForJeep(jeepId);
            sendJson(exchange, 200, "{\"ok\":true,\"jeepId\":\"" + escapeJson(jeepId) + "\"}");
        });

        server.setExecutor(null);
        server.start();
        System.out.println("Backend server running on http://localhost:" + port + "/api/jeeps");
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
        int startQuote = json.indexOf("\"", colonIdx + 1);
        int endQuote = json.indexOf("\"", startQuote + 1);
        if (startQuote == -1 || endQuote == -1) return "";
        return json.substring(startQuote + 1, endQuote);
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    public static void main(String[] args) throws Exception {
        startServer(8080);
    }
}