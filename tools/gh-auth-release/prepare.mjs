import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const upstreamRepository = "BytePioneer-AI/codex-host";

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`invalid argument: ${name ?? ""}`);
    values.set(name.slice(2), value);
  }
  return values;
}

function requireRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`invalid GitHub repository: ${value}`);
  }
  return value;
}

function requireVersion(value) {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(`upstream stable version must be major.minor.patch: ${value}`);
  }
  return value;
}

function requireRevision(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`channel revision must be a positive integer: ${value}`);
  }
  return value;
}

function sourceFile(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

function transform(filePath, transformSource) {
  const source = readFileSync(filePath, "utf8");
  const result = transformSource(source);
  if (result === source) return false;
  writeFileSync(filePath, result, "utf8");
  return true;
}

function replaceExactly(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(before, after);
}

function installAuthenticatedDiscovery(root) {
  const helperPath = sourceFile(root, "packages/update-manager/src/github-cli-release.ts");
  let helperExists = false;
  let helperInstalled = false;
  try {
    const helperSource = readFileSync(helperPath, "utf8");
    helperExists = true;
    helperInstalled = helperSource.includes("fetchLatestGitHubReleaseWithGitHubCli");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (helperExists && !helperInstalled) {
    throw new Error("upstream added an incompatible github-cli-release.ts; review it manually");
  }
  if (!helperInstalled) {
    copyFileSync(path.join(toolRoot, "github-cli-release.ts.template"), helperPath);
  }
  copyFileSync(
    path.join(toolRoot, "github-cli-release.test.ts.template"),
    sourceFile(root, "packages/update-manager/test/github-cli-release.test.ts"),
  );

  const indexPath = sourceFile(root, "packages/update-manager/src/index.ts");
  transform(indexPath, (source) => {
    if (source.includes('from "./github-cli-release.js"')) return source;
    return `${source.trimEnd()}\nexport {\n  fetchLatestGitHubReleaseWithGitHubCli,\n  type GitHubCliReleaseFetchOptions,\n  type GitHubCliRunner,\n} from "./github-cli-release.js";\n`;
  });

  const coordinatorPath = sourceFile(root, "packages/host-runtime/src/update-coordinator.ts");
  transform(coordinatorPath, (source) => {
    let result = source;
    if (!result.includes("fetchLatestGitHubReleaseWithGitHubCli,")) {
      result = replaceExactly(
        result,
        "  fetchLatestGitHubRelease,\n",
        "  fetchLatestGitHubRelease,\n  fetchLatestGitHubReleaseWithGitHubCli,\n",
        "update coordinator import",
      );
    }
    if (!result.includes("const authenticated = await fetchLatestGitHubReleaseWithGitHubCli")) {
      result = replaceExactly(
        result,
        `    ((signal?: AbortSignal) =>\n      fetchLatestGitHubRelease({ signal: signal ?? AbortSignal.timeout(15_000) }));`,
        `    (async (signal?: AbortSignal) => {\n      const timeoutSignal = AbortSignal.timeout(15_000);\n      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;\n      const authenticated = await fetchLatestGitHubReleaseWithGitHubCli({\n        ...(options.environment ? { environment: options.environment } : {}),\n        platform,\n        signal: requestSignal,\n      });\n      return authenticated ?? fetchLatestGitHubRelease({ signal: requestSignal });\n    });`,
        "update coordinator discovery",
      );
    }
    return result;
  });
}

function routeReleaseChannel(root, releaseRepository) {
  const requiredReleaseFiles = [
    "packages/update-manager/src/github-release.ts",
    "packages/update-manager/src/github-cli-release.ts",
    "packages/shared-contracts/src/updates.ts",
    "packages/renderer-extension/src/settings/pages.ts",
    "crates/platform/src/desktop_launch.rs",
  ];
  const optionalReleaseFiles = [
    "packages/update-manager/test/github-release.test.ts",
    "packages/update-manager/test/github-cli-release.test.ts",
    "packages/update-manager/test/github-cli-process.test.ts",
    "packages/host-runtime/test/update-coordinator.test.ts",
    "packages/shared-contracts/test/updates.test.ts",
    "packages/renderer-extension/test/settings/pages.test.ts",
  ];
  const rewrite = (relativePath) => {
    const filePath = sourceFile(root, relativePath);
    return transform(filePath, (source) =>
      source
        .replaceAll(upstreamRepository, releaseRepository)
        .replaceAll(
          upstreamRepository.replaceAll("/", "\\/"),
          releaseRepository.replaceAll("/", "\\/"),
        ),
    );
  };
  for (const relativePath of requiredReleaseFiles) rewrite(relativePath);
  for (const relativePath of optionalReleaseFiles) {
    try {
      rewrite(relativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function verifyPreparedSource(root, releaseRepository, customVersion) {
  const packageManifest = JSON.parse(readFileSync(sourceFile(root, "package.json"), "utf8"));
  if (packageManifest.version !== customVersion) {
    throw new Error(`package version is ${packageManifest.version}, expected ${customVersion}`);
  }
  const helper = readFileSync(
    sourceFile(root, "packages/update-manager/src/github-cli-release.ts"),
    "utf8",
  );
  if (!helper.includes(`repos/${releaseRepository}/releases/latest`)) {
    throw new Error("GitHub CLI release endpoint was not routed to the custom channel");
  }
  const releaseClient = readFileSync(
    sourceFile(root, "packages/update-manager/src/github-release.ts"),
    "utf8",
  );
  if (!releaseClient.includes(`api.github.com/repos/${releaseRepository}/releases/latest`)) {
    throw new Error("HTTP release endpoint was not routed to the custom channel");
  }
  const coordinator = readFileSync(
    sourceFile(root, "packages/host-runtime/src/update-coordinator.ts"),
    "utf8",
  );
  if (!coordinator.includes("fetchLatestGitHubReleaseWithGitHubCli")) {
    throw new Error("authenticated GitHub CLI discovery is missing from the coordinator");
  }
  const sharedContracts = readFileSync(
    sourceFile(root, "packages/shared-contracts/src/updates.ts"),
    "utf8",
  );
  if (!sharedContracts.includes(releaseRepository.replaceAll("/", "\\/"))) {
    throw new Error("shared Release URL contract was not routed to the custom channel");
  }
  for (const relativePath of [
    "packages/renderer-extension/src/settings/pages.ts",
    "crates/platform/src/desktop_launch.rs",
  ]) {
    const source = readFileSync(sourceFile(root, relativePath), "utf8");
    if (!source.includes(`github.com/${releaseRepository}/releases`)) {
      throw new Error(`${relativePath} was not routed to the custom channel`);
    }
  }
}

const arguments_ = parseArguments(process.argv.slice(2));
const root = path.resolve(arguments_.get("source") ?? "");
const upstreamVersion = requireVersion(arguments_.get("version") ?? "");
const releaseRepository = requireRepository(arguments_.get("repository") ?? "");
const revision = requireRevision(arguments_.get("revision") ?? "");
const customVersion = `${upstreamVersion}-gh.${revision}`;

installAuthenticatedDiscovery(root);
routeReleaseChannel(root, releaseRepository);
const releasePrepareModule = await import(
  pathToFileURL(sourceFile(root, "scripts/release/prepare-version.mjs")).href
);
await releasePrepareModule.prepareReleaseVersion({ version: customVersion, root });
verifyPreparedSource(root, releaseRepository, customVersion);
process.stdout.write(`custom_version=${customVersion}\n`);
