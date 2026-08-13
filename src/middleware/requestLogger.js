/**
 * Lightweight request logger — no external dependency.
 * Never logs Authorization headers or request bodies that may contain secrets.
 */
export function requestLogger(req, res, next) {
  const started = Date.now();
  const { method } = req;
  const path = req.originalUrl || req.url;

  res.on("finish", () => {
    const ms = Date.now() - started;
    const userAgent = req.get("user-agent") || "-";
    console.log(
      `[${new Date().toISOString()}] ${method} ${path} → ${res.statusCode} (${ms}ms) ua=${userAgent.slice(0, 80)}`,
    );
  });

  next();
}
