/**
 * Selects a locally available Chromium executable for Playwright.
 *
 * The site-understanding CLI and browser tests both need a real browser, while
 * CI and developer machines may install it in different locations. This module
 * keeps that environment concern out of the observer and exploration logic. It
 * prefers an explicit `PLAYWRIGHT_CHROMIUM_PATH`, then checks Playwright's
 * managed browser, common system installations, and finally PATH. If no
 * executable is found, Playwright receives its normal launch configuration so
 * its own diagnostic remains visible to the caller.
 */
import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type LaunchOptions } from "playwright";

function executable(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

function pathExecutable(command: string): string | undefined {
  try {
    const pathValue = execFileSync(platform() === "win32" ? "where" : "which", [command], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
    return executable(pathValue);
  } catch {
    return undefined;
  }
}

/**
 * Return launch options for a locally installed Chromium-compatible browser.
 * `PLAYWRIGHT_CHROMIUM_PATH` is deliberately authoritative so CI can pin a
 * known revision. A missing executable leaves `executablePath` unset and lets
 * Playwright report its standard managed-browser error.
 */
export function chromiumLaunchOptions(): LaunchOptions {
  const explicit = executable(process.env.PLAYWRIGHT_CHROMIUM_PATH);
  if (explicit) return { headless: true, executablePath: explicit };

  const managed = executable(chromium.executablePath());
  if (managed) return { headless: true, executablePath: managed };

  const candidates = platform() === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ]
    : platform() === "win32"
      ? [
          join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
          join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  for (const candidate of candidates) {
    const found = executable(candidate);
    if (found) return { headless: true, executablePath: found };
  }

  for (const command of ["google-chrome", "chromium", "chromium-browser", "chrome"]) {
    const found = pathExecutable(command);
    if (found) return { headless: true, executablePath: found };
  }

  // Keep the option shape explicit for callers and let Playwright produce the
  // actionable managed-browser installation message when none is available.
  return { headless: true };
}
