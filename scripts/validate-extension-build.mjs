import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";

const outputDirectory = path.resolve("build-extension");
const manifestPath = path.join(outputDirectory, "manifest.json");
const workerPath = path.join(outputDirectory, "assets/service-worker.js");

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

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.background?.service_worker !== "assets/service-worker.js") {
  throw new Error('manifest background.service_worker must be "assets/service-worker.js"');
}

await assertFileExists(workerPath, "service-worker.js");
for (const reference of collectManifestFileReferences(manifest)) {
  const resolvedPath = path.resolve(outputDirectory, reference);
  if (!resolvedPath.startsWith(`${outputDirectory}${path.sep}`)) {
    throw new Error(`Manifest file reference escapes the extension output: ${reference}`);
  }
  await assertFileExists(resolvedPath, `Manifest-referenced file ${reference}`);
}

const workerSource = await readFile(workerPath, "utf8");
const dependencies = findModuleDependencies(workerSource);
if (dependencies.length > 0) {
  const details = dependencies
    .map(({ type, specifier }) => `${type} import ${specifier}`)
    .join(", ");
  throw new Error(`service-worker.js must be self-contained; found ${details}`);
}

console.log(
  `Validated extension build: ${path.relative(process.cwd(), workerPath)} (${workerSource.length} bytes, no module dependencies)`,
);
