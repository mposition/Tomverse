// Private inventory v3 records repository roots, local refs, worktree HEADs,
// Git status entries, index hashes, and hashes of nonignored dirty files.
// Build caches and ignored files are outside this verifier's scope.
// A seeded recovery mirror may contain additional upstream refs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// Git location overrides must not redirect verification to the old checkout.
const gitEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith("GIT_")));
const git = (...args) => execFileSync("git", args, {
  env: gitEnv,
  maxBuffer: 32 * 1024 * 1024,
});
const gitPath = (worktree, option) => realpathSync(resolve(worktree,
  git("-C", worktree, "rev-parse", option).toString("utf8").trim()));
const lines = (value) => value.toString("utf8").split(/\r?\n/).filter(Boolean);

function fail(message) {
  throw new Error(message);
}

function mapping(value, flag) {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) {
    fail(flag + " requires source=destination");
  }
  return [value.slice(0, index), resolve(value.slice(index + 1))];
}

function fileAt(root, relative) {
  const target = resolve(root, relative);
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (!realTarget.startsWith(realRoot + sep)) {
    fail("inventory path escapes recovered worktree");
  }
  if (!lstatSync(target).isFile()) {
    fail("expected a regular recovered file: " + relative);
  }
  return target;
}

function checkFile(root, item) {
  const target = fileAt(root, item.path);
  const data = readFileSync(target);
  if (data.length !== item.bytes || sha256(data) !== item.sha256) {
    fail("recovered file differs: " + item.path);
  }
}

function checkRecovered(worktree, destination, mirror) {
  const realDestination = realpathSync(destination);
  const realMirror = realpathSync(mirror);
  const top = gitPath(destination, "--show-toplevel");
  const common = gitPath(destination, "--git-common-dir");
  const gitdir = gitPath(destination, "--git-dir");
  if (top !== realDestination || common !== realMirror ||
      !gitdir.startsWith(realMirror + sep)) {
    fail("recovered worktree is not isolated in its mapped mirror");
  }
  if (existsSync(resolve(gitdir, "objects/info/alternates"))) {
    fail("recovered worktree depends on an alternate object store");
  }
  const head = git("-C", destination, "rev-parse", "HEAD").toString("utf8").trim();
  if (head !== worktree.head) {
    fail("recovered worktree HEAD differs: " + worktree.path);
  }
  const status = lines(git("-C", destination, "status", "--porcelain=v1", "--untracked-files=all"));
  const expected = worktree.status.entries;
  if (JSON.stringify(status.sort()) !== JSON.stringify([...expected].sort())) {
    fail("recovered worktree status differs: " + worktree.path);
  }
  const index = sha256(git("-C", destination, "ls-files", "--stage", "-z"));
  if (index !== worktree.status.indexEntriesSha256) {
    fail("recovered worktree index differs: " + worktree.path);
  }
  for (const item of worktree.status.unstagedTrackedFiles) {
    checkFile(destination, item);
  }
  for (const item of worktree.untrackedFiles) {
    checkFile(destination, item);
  }
}

function main(argv) {
  let inventoryPath;
  const mirrors = new Map();
  const recovered = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      fail("missing value for " + flag);
    }
    if (flag === "--inventory") {
      inventoryPath = resolve(value);
    } else if (flag === "--mirror") {
      const [source, destination] = mapping(value, flag);
      mirrors.set(source, destination);
    } else if (flag === "--recovered") {
      const [source, destination] = mapping(value, flag);
      recovered.set(source, destination);
    } else {
      fail("unknown option: " + flag);
    }
  }
  if (!inventoryPath) {
    fail("--inventory is required");
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  if (inventory.schema !== "tomverse-wsl-git-inventory-v3" ||
      !Array.isArray(inventory.repositories)) {
    fail("unsupported inventory schema");
  }

  let refs = 0;
  let heads = 0;
  let dirty = 0;
  for (const repository of inventory.repositories) {
    const mirror = mirrors.get(repository.root);
    if (!mirror) {
      fail("missing mirror mapping: " + repository.root);
    }
    if (existsSync(resolve(mirror, "objects/info/alternates"))) {
      fail("recovery mirror depends on an alternate object store");
    }
    const actual = new Map(lines(git("--git-dir", mirror, "for-each-ref",
      "--format=%(refname)%09%(objectname)")).map((line) => line.split("\t")));
    for (const ref of repository.localRefs) {
      if (actual.get(ref.name) !== ref.sha) {
        fail("recovery ref differs: " + ref.name);
      }
      refs += 1;
    }
    const anchors = new Set([...actual.entries()]
      .filter(([name]) => name.startsWith("refs/migration/wsl/worktree-heads/"))
      .map(([, sha]) => sha));
    for (const worktree of repository.worktrees) {
      if (!anchors.has(worktree.head)) {
        fail("worktree HEAD is not anchored: " + worktree.path);
      }
      git("--git-dir", mirror, "cat-file", "-e", worktree.head + "^{commit}");
      heads += 1;
      if (worktree.exists && worktree.status.entries.length > 0) {
        const destination = recovered.get(worktree.path);
        if (!destination) {
          fail("missing recovered worktree mapping: " + worktree.path);
        }
        checkRecovered(worktree, destination, mirror);
        dirty += 1;
      }
    }
    git("--git-dir", mirror, "fsck", "--full", "--no-reflogs");
  }
  if (mirrors.size !== inventory.repositories.length || recovered.size !== dirty) {
    fail("unexpected mirror or recovered worktree mapping");
  }
  process.stdout.write(JSON.stringify({
    repositories: inventory.repositories.length,
    refs,
    worktreeHeads: heads,
    recoveredDirtyWorktrees: dirty,
    ignoredFiles: "excluded from inventory and verification",
    result: "ok",
  }) + "\n");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write("Git migration verification failed: " + error.message + "\n");
  process.exitCode = 1;
}
