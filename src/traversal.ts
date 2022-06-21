import { Package, Graph } from '.';
import { getPackageName } from './parse';

const EMPTY_MAP = new Map();

export const traversePackageDependenciesOnce = <T>(
  traverseFunc: (graphPath: Package[], context: T, isWorkspace: boolean) => T,
  graph: Package,
  context: T,
  isWorkspace = true,
  graphPath: Package[] = [graph],
  seen: Set<Package> = new Set()
) => {
  const pkg = graphPath[graphPath.length - 1];
  const nextContext = traverseFunc(graphPath, context, isWorkspace);

  if (seen.has(pkg)) return;
  seen.add(pkg);

  for (const dep of pkg.dependencies || []) {
    graphPath.push(dep);
    traversePackageDependenciesOnce(traverseFunc, graph, nextContext, false, graphPath, seen);
    graphPath.pop();
  }

  for (const dep of pkg.workspaces || []) {
    graphPath.push(dep);
    traversePackageDependenciesOnce(traverseFunc, graph, nextContext, true, graphPath, seen);
    graphPath.pop();
  }
};

export const traverseDependenciesOnce = <T>(
  traverseFunc: (graphPath: Graph[], context: T, isWorkspace: boolean) => T,
  graph: Graph,
  context: T,
  isWorkspace = true,
  graphPath: Graph[] = [graph],
  seen: Set<Graph> = new Set()
) => {
  const pkg = graphPath[graphPath.length - 1];
  if (seen.has(pkg)) return;
  seen.add(pkg);

  const nextContext = traverseFunc(graphPath, context, isWorkspace);

  for (const dep of (pkg.dependencies || EMPTY_MAP).values()) {
    graphPath.push(dep);
    traverseDependenciesOnce(traverseFunc, graph, nextContext, false, graphPath, seen);
    graphPath.pop();
  }

  for (const dep of (pkg.workspaces || EMPTY_MAP).values()) {
    graphPath.push(dep);
    traverseDependenciesOnce(traverseFunc, graph, nextContext, true, graphPath, seen);
    graphPath.pop();
  }
};

export const traverseWorkspacesOnce = <T>(
  traverseFunc: (graphPath: Graph[], context: T) => T,
  graph: Graph,
  context: T,
  graphPath: Graph[] = [graph],
  seen: Set<Graph> = new Set()
) => {
  const pkg = graphPath[graphPath.length - 1];
  if (seen.has(pkg)) return;
  seen.add(pkg);

  const nextContext = traverseFunc(graphPath, context);

  for (const dep of (pkg.workspaces || EMPTY_MAP).values()) {
    graphPath.push(dep);
    traverseWorkspacesOnce(traverseFunc, graph, nextContext, graphPath, seen);
    graphPath.pop();
  }
};

export const traverseDependencies = <T>(
  traverseFunc: (graphPath: Graph[], context: T) => T,
  graph: Graph,
  context: T,
  graphPath: Graph[] = [graph]
) => {
  const pkg = graphPath[graphPath.length - 1];
  const pkgName = getPackageName(pkg.id);
  const nextContext = traverseFunc(graphPath, context);
  const parentPkg = graphPath.length > 1 ? graphPath[graphPath.length - 2] : null;
  let isReachable = !parentPkg ? true : false;
  if (parentPkg) {
    if (parentPkg.workspaces) {
      const dep = parentPkg.workspaces.get(pkgName);
      if (dep && dep.id === pkg.id) {
        isReachable = true;
      }
    }
    if (parentPkg.dependencies) {
      const dep = parentPkg.dependencies.get(pkgName);
      if (dep && dep.id === pkg.id) {
        isReachable = true;
      }
    }
  }

  if (!isReachable || graphPath.indexOf(pkg) !== graphPath.length - 1) return;

  const visitedDepNames = new Set();
  let anotherPassNeeded;
  if (pkg.dependencies) {
    do {
      anotherPassNeeded = false;
      const sortedEntries = Array.from(pkg.dependencies.entries()).sort((x1, x2) =>
        x1[0] === x2[0] ? 0 : x1[0] < x2[0] ? -1 : 1
      );
      for (const [depName, dep] of sortedEntries) {
        if (!visitedDepNames.has(depName)) {
          anotherPassNeeded = true;
          graphPath.push(dep);
          traverseDependencies(traverseFunc, graph, nextContext, graphPath);
          graphPath.pop();
          visitedDepNames.add(depName);
        }
      }
    } while (anotherPassNeeded);
  }

  if (pkg.workspaces) {
    visitedDepNames.clear();
    do {
      anotherPassNeeded = false;
      const sortedEntries = Array.from(pkg.workspaces.entries()).sort((x1, x2) =>
        x1[0] === x2[0] ? 0 : x1[0] < x2[0] ? -1 : 1
      );
      for (const [depName, dep] of sortedEntries) {
        if (!visitedDepNames.has(depName)) {
          graphPath.push(dep);
          traverseDependencies(traverseFunc, graph, nextContext, graphPath);
          graphPath.pop();
          visitedDepNames.add(depName);
        }
      }
    } while (anotherPassNeeded);
  }
};
