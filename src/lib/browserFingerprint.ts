/**
 * Browser Fingerprint — Generates and persists realistic browser identities
 *
 * Uses Baileys' built-in Browsers helper to produce real WhatsApp Web
 * browser strings instead of a custom/fake one that could be flagged.
 *
 * Each session gets a fingerprint persisted to sessions/<id>/browser.json
 * so reconnects use the same identity (changing fingerprint mid-session
 * can trigger re-auth or bans).
 */

import { Browsers } from "@whiskeysockets/baileys";
import type { WABrowserDescription } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

/** Realistic browser combinations that match real WhatsApp Web users */
const BROWSER_POOL: Array<() => WABrowserDescription> = [
    () => Browsers.windows("Chrome"),
    () => Browsers.windows("Edge"),
    () => Browsers.windows("Firefox"),
    () => Browsers.macOS("Chrome"),
    () => Browsers.macOS("Safari"),
    () => Browsers.macOS("Firefox"),
    () => Browsers.ubuntu("Chrome"),
    () => Browsers.ubuntu("Firefox"),
];

interface PersistedFingerprint {
    browser: WABrowserDescription;
    createdAt: string;
}

/**
 * Get or create a browser fingerprint for a session.
 * - If a persisted fingerprint exists in sessions/<id>/browser.json, it is reused.
 * - Otherwise, a random one is generated from the pool and persisted.
 */
export function getBrowserFingerprint(
    sessionId: string,
    sessionsDir: string
): WABrowserDescription {
    const sessionDir = path.join(sessionsDir, sessionId);
    const fpPath = path.join(sessionDir, "browser.json");

    // Try to load existing fingerprint
    try {
        if (fs.existsSync(fpPath)) {
            const data: PersistedFingerprint = JSON.parse(fs.readFileSync(fpPath, "utf-8"));
            if (Array.isArray(data.browser) && data.browser.length === 3) {
                console.log(`[fingerprint] Loaded persisted browser for ${sessionId}: ${JSON.stringify(data.browser)}`);
                return data.browser;
            }
        }
    } catch (err) {
        console.warn(`[fingerprint] Failed to load browser.json for ${sessionId}, generating new:`, err);
    }

    // Generate a new random fingerprint
    const randomIndex = Math.floor(Math.random() * BROWSER_POOL.length);
    const browser = BROWSER_POOL[randomIndex]();

    // Persist it
    try {
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        const persisted: PersistedFingerprint = {
            browser,
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(fpPath, JSON.stringify(persisted, null, 2));
        console.log(`[fingerprint] Generated new browser for ${sessionId}: ${JSON.stringify(browser)}`);
    } catch (err) {
        console.error(`[fingerprint] Failed to save browser.json for ${sessionId}:`, err);
    }

    return browser;
}
