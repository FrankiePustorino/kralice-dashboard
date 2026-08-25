import { execFile } from 'child_process';

// Wrapper around execFile (never `exec` with string concatenation — that's
// how you get shell-injection bugs) that resolves with stdout/stderr instead
// of throwing, so callers can surface real error text to the dashboard UI.
export function run(cmd, args = [], opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000, maxBuffer: 5 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                code: error ? (error.code ?? 1) : 0,
                stdout: stdout?.toString() ?? '',
                stderr: stderr?.toString() ?? (error ? error.message : '')
            });
        });
    });
}
