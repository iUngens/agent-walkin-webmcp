/**
 * Provider-neutral verification for immutable static WebMCP package assets.
 * The CLI uses this after a merchant or platform host has published a package;
 * it never uploads files or sends action calls to the package host.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

interface PackageManifest {
  packageId: string;
  version: string;
  files: Array<{ path: string; sha256: string }>;
}

export interface HostedVerificationResult {
  baseUrl: string;
  packageId: string;
  version: string;
  verifiedFiles: number;
}

function digest(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function packagePath(root: string, filePath: string): string {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\")) {
    throw new Error(`Invalid package file path in manifest: ${filePath}`);
  }
  const target = resolve(root, filePath);
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Package path escapes its root: ${filePath}`);
  return target;
}

/**
 * Compare every downloaded package file with its public static-host URL.
 * `baseUrl` must point at the package's versioned directory and end in `/`.
 * The manifest hashes payload assets; metadata and manifest are also compared
 * byte-for-byte, although they cannot contain a non-circular hash of themselves.
 * Raw bytes are compared so invalid UTF-8 cannot decode to a false match.
 */
export async function verifyHostedPackage(
  directory: string,
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<HostedVerificationResult> {
  const root = resolve(directory);
  const manifestText = await readFile(join(root, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as PackageManifest;
  if (!manifest.packageId || !manifest.version || !Array.isArray(manifest.files)) {
    throw new Error("Package manifest is missing identity or file hashes.");
  }
  const parsedBase = new URL(baseUrl);
  if (!/^https?:$/.test(parsedBase.protocol)) throw new Error("Hosted package URL must use HTTP or HTTPS.");
  if (!parsedBase.pathname.endsWith("/")) parsedBase.pathname += "/";

  const listedPaths = manifest.files.map((file) => file.path);
  if (new Set(listedPaths).size !== listedPaths.length) throw new Error("Package manifest contains duplicate file paths.");
  const paths = [...listedPaths, "metadata.json", "manifest.json"];
  for (const file of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid SHA-256 for ${file.path}.`);
    const local = await readFile(packagePath(root, file.path));
    if (digest(local) !== file.sha256) throw new Error(`Downloaded package integrity check failed for ${file.path}.`);
  }

  for (const path of paths) {
    const local = await readFile(packagePath(root, path));
    const url = new URL(path.split("/").map(encodeURIComponent).join("/"), parsedBase);
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Hosted asset request failed (${response.status}) for ${path}.`);
    const hosted = new Uint8Array(await response.arrayBuffer());
    if (!Buffer.from(hosted).equals(local)) throw new Error(`Hosted asset does not match the downloaded package: ${path}.`);
  }
  return { baseUrl: parsedBase.toString(), packageId: manifest.packageId, version: manifest.version, verifiedFiles: paths.length };
}
