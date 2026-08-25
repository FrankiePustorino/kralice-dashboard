// Simple shared-token auth. Not OAuth, not sessions — just enough to keep
// this off the open internet if it's ever reachable through a reverse proxy
// or DDNS host. Set DASHBOARD_TOKEN in .env.
export function authMiddleware(req, res, next) {
    const required = process.env.DASHBOARD_TOKEN;
    if (!required) {
        // No token configured — allow through, but make it loud in the logs.
        return next();
    }
    const provided = req.headers['x-dashboard-token'] || req.query.token;
    if (provided !== required) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid dashboard token.' });
    }
    next();
}
