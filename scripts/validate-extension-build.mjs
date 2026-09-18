import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";

const extensionEnvironment = process.env.VITE_EXTENSION_ENV === "store" ? "store" : "dev";
const outputDirectory = path.resolve(
  process.env.VITE_EXTENSION_OUTPUT ||
    (extensionEnvironment === "store" ? "build-extension-store" : "build-extension"),
);
const sourceDirectories = [path.resolve("src"), path.resolve("public")];
const manifestPath = path.join(outputDirectory, "manifest.json");
const popupPath = path.join(outputDirectory, "index.html");
const workerPath = path.join(outputDirectory, "assets/service-worker.js");
const expectedStoreHostPermissions = ["https://api.copyyt.psami.com/*"];
const expectedStoreEndpoint = "https://api.copyyt.psami.com";
const expectedStorePermissions = [
  "identity",
  "clipboardRead",
  "clipboardWrite",
  "offscreen",
  "storage",
  "alarms",
];

async function assertFileExists(filePath, description) {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new Error(`${description} does not exist: ${path.relative(outputDirectory, filePath)}`);
  }
  if (!fileStats.isFile() || fileStats.size === 0) {
    throw new Error(`${description} is empty or not a regular file: ${path.relative(outputDirectory, filePath)}`);
  }
}

function collectManifestFileReferences(manifest) {
  const fileReferenceKeys = new Set([
    "service_worker",
    "default_popup",
    "default_icon",
    "options_page",
    "page",
    "devtools_page",
    "default_path",
    "js",
    "css",
    "resources",
    "pages",
  ]);
  const references = [];

  function visit(value, key = "") {
    if (typeof value === "string") {
      if (fileReferenceKeys.has(key) && !value.includes("*") && !/^\w+:\/\//u.test(value)) {
        references.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === "object") {
      if (key === "icons") {
        for (const iconPath of Object.values(value)) {
          if (typeof iconPath === "string") references.push(iconPath);
        }
        return;
      }
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey);
      }
    }
  }

  visit(manifest);
  return [...new Set(references)];
}

function findModuleDependencies(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const dependencies = [];

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportDeclaration") {
      dependencies.push({ type: "static", specifier: node.source.value });
    } else if (node.type === "ImportExpression") {
      dependencies.push({ type: "dynamic", specifier: node.source?.value ?? "<non-literal>" });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else {
        visit(value);
      }
    }
  }

  visit(ast);
  return dependencies;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function isPrivateHostPermission(permission) {
  const normalized = permission.toLowerCase();
  return (
    normalized.includes("localhost") ||
    /https?:\/\/(?:127\.|0\.0\.0\.0|10\.|169\.254\.|192\.168\.)/u.test(normalized) ||
    /https?:\/\/172\.(?:1[6-9]|2\d|3[01])\./u.test(normalized)
  );
}

function assertSameList(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label} must be exactly ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
    );
  }
}

function assertNoRemoteExecutableCode(filePath, source) {
  const checks = [
    { pattern: /\beval\s*\(/u, description: "eval()" },
    { pattern: /\bnew\s+Function\s*\(/u, description: "new Function()" },
    { pattern: /(?<!new\s)\bFunction\s*\(/u, description: "Function()" },
    {
      pattern: /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//iu,
      description: "a remotely loaded script tag",
    },
    {
      pattern: /\b(?:src|href)\s*=\s*["']https?:\/\/[^"']+\.js(?:[?#][^"']*)?["']/iu,
      description: "a remote JavaScript resource",
    },
    {
      pattern: /\bimport\s*\(\s*["']https?:\/\//iu,
      description: "a remotely loaded dynamic import",
    },
  ];
  for (const { pattern, description } of checks) {
    if (pattern.test(source)) {
      throw new Error(`${description} found in ${path.relative(process.cwd(), filePath)}`);
    }
  }
}

async function auditRemoteCode(files, label) {
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    assertNoRemoteExecutableCode(filePath, source);
  }
  console.log(`Audited ${files.length} ${label} files for MV3 remote-code violations`);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.background?.service_worker !== "assets/service-worker.js") {
  throw new Error('manifest background.service_worker must be "assets/service-worker.js"');
}

if (extensionEnvironment === "store") {
  if (manifest.manifest_version !== 3) {
    throw new Error("The Store manifest must use manifest_version 3");
  }
  if (manifest.version !== "2.0.0") {
    throw new Error(`The Store manifest must be version 2.0.0; got ${manifest.version}`);
  }
  if (
    process.env.VITE_API_URL !== expectedStoreEndpoint ||
    process.env.VITE_SOCKET_URL !== expectedStoreEndpoint
  ) {
    throw new Error(
      `Store builds must use ${expectedStoreEndpoint} for both VITE_API_URL and VITE_SOCKET_URL`,
    );
  }
  assertSameList(manifest.permissions ?? [], expectedStorePermissions, "Store permissions");
  assertSameList(
    manifest.host_permissions ?? [],
    expectedStoreHostPermissions,
    "Store host permissions",
  );
  const privateHostPermission = (manifest.host_permissions ?? []).find(isPrivateHostPermission);
  if (privateHostPermission) {
    throw new Error(`Store manifest contains a localhost/private-LAN host permission: ${privateHostPermission}`);
  }
}

await assertFileExists(workerPath, "service-worker.js");
for (const reference of collectManifestFileReferences(manifest)) {
  const resolvedPath = path.resolve(outputDirectory, reference);
  if (!resolvedPath.startsWith(`${outputDirectory}${path.sep}`)) {
    throw new Error(`Manifest file reference escapes the extension output: ${reference}`);
  }
  await assertFileExists(resolvedPath, `Manifest-referenced file ${reference}`);
}

const popupSource = await readFile(popupPath, "utf8");
if (/\brel\s*=\s*["']modulepreload["']/iu.test(popupSource)) {
  throw new Error(`${path.basename(outputDirectory)}/index.html must not contain rel="modulepreload"`);
}

const workerSource = await readFile(workerPath, "utf8");
const dependencies = findModuleDependencies(workerSource);
if (dependencies.length > 0) {
  const details = dependencies
    .map(({ type, specifier }) => `${type} import ${specifier}`)
    .join(", ");
  throw new Error(`service-worker.js must be self-contained; found ${details}`);
}

const sourceFiles = (
  await Promise.all(sourceDirectories.map((directory) => collectFiles(directory)))
).flat();
const artifactFiles = await collectFiles(outputDirectory);
for (const filePath of artifactFiles.filter((candidate) => /\.html$/iu.test(candidate))) {
  const source = await readFile(filePath, "utf8");
  if (/\brel\s*=\s*["']modulepreload["']/iu.test(source)) {
    throw new Error(`${path.relative(process.cwd(), filePath)} must not contain rel="modulepreload"`);
  }
}
const auditableSourceFiles = sourceFiles.filter((filePath) =>
  /\.(?:html|js|mjs|ts|tsx)$/iu.test(filePath),
);
const auditableArtifactFiles = artifactFiles.filter((filePath) =>
  /\.(?:html|js|mjs|ts|tsx)$/iu.test(filePath),
);
await auditRemoteCode(auditableSourceFiles, "source");
await auditRemoteCode(auditableArtifactFiles, "artifact");

console.log(
  `Validated extension build: ${path.relative(process.cwd(), workerPath)} (${workerSource.length} bytes, no module dependencies)`,
);
