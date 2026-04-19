#!/usr/bin/env bun

const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;

type PackageJson = {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

async function readPackageJson(packageDir: string): Promise<PackageJson | null> {
  try {
    const file = Bun.file(`${PACKAGES_DIR}/${packageDir}/package.json`);
    return await file.json();
  } catch {
    return null;
  }
}

function getInternalDeps(pkg: PackageJson): string[] {
  // peerDependencies define the real build-time requirements
  // "I need X to exist before I can be used"
  const buildDeps = {
    ...pkg.peerDependencies,
  };
  return Object.keys(buildDeps).filter((dep) => dep.startsWith('coco-cashu-'));
}

function topologicalSort(packages: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected at ${name}`);
    }
    visiting.add(name);
    const deps = packages.get(name) ?? [];
    for (const dep of deps) {
      if (packages.has(dep)) {
        visit(dep);
      }
    }
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  }

  // Sort by number of dependencies first so nodes with no deps are visited first
  const sorted = [...packages.keys()].sort((a, b) => {
    return (packages.get(a)?.length ?? 0) - (packages.get(b)?.length ?? 0);
  });

  for (const name of sorted) {
    visit(name);
  }

  return result;
}

async function main() {
  const glob = new Bun.Glob('*/package.json');
  const packageMap = new Map<string, PackageJson>();
  const nameToDir = new Map<string, string>();

  for await (const file of glob.scan(PACKAGES_DIR)) {
    const dir = file.split('/')[0];
    const pkg = await readPackageJson(dir);
    if (!pkg?.name) continue;
    if (!pkg.scripts?.build) continue;
    packageMap.set(pkg.name, pkg);
    nameToDir.set(pkg.name, dir);
  }

  // Build dependency graph (only internal deps)
  const depGraph = new Map<string, string[]>();
  for (const [name, pkg] of packageMap) {
    const internalDeps = getInternalDeps(pkg).filter((dep) => packageMap.has(dep));
    depGraph.set(name, internalDeps);
  }

  const buildOrder = topologicalSort(depGraph);

  console.log('Build order:');
  buildOrder.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));
  console.log('');

  for (const name of buildOrder) {
    const dir = nameToDir.get(name)!;
    console.log(`Building ${name}...`);
    const result = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: `${PACKAGES_DIR}/${dir}`,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) {
      console.error(`Failed to build ${name}`);
      process.exit(1);
    }
    console.log(`✓ ${name} built successfully\n`);
  }
}

main();
