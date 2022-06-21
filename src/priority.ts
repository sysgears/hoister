import { PackageName, PackageId, PackageType, Graph } from '.';
import { getPackageName } from './parse';
import { traverseDependenciesOnce, traverseWorkspacesOnce } from './traversal';

export type HoistPriorities = Map<PackageName, PackageId[]>;

const EMPTY_SET = new Set();

export const getHoistPriorities = (graph: Graph): HoistPriorities => {
  const priorities = new Map();
  const workspaceLevels = new Map<PackageId, number>();
  let maxWorkspaceLevel = 0;
  const packageMetrics = new Map();

  traverseWorkspacesOnce(
    (graphPath, context) => {
      const pkg = graphPath[graphPath.length - 1];

      const workspaceLevel = context.workspaceLevel + 1;
      if (workspaceLevel > maxWorkspaceLevel) {
        maxWorkspaceLevel = workspaceLevel;
      }
      workspaceLevels.set(pkg.id, workspaceLevel);

      return { workspaceLevel };
    },
    graph,
    { workspaceLevel: 1 }
  );

  traverseDependenciesOnce(
    (graphPath, context) => {
      const pkg = graphPath[graphPath.length - 1];

      let metrics = packageMetrics.get(pkg.id);
      if (!metrics) {
        metrics = {
          directDependencyLevel: maxWorkspaceLevel + 1,
          peerCount: (pkg.peerNames || EMPTY_SET).size,
          parents: new Set(),
        };
        packageMetrics.set(pkg.id, metrics);
      }

      if (context.isDirectDependency && context.workspaceLevel < metrics.directDependencyLevel) {
        metrics.directDependencyLevel = context.workspaceLevel;
      }
      if (graphPath.length > 1) {
        metrics.parents.add(graphPath[graphPath.length - 2]);
      }

      const nextContext = { ...context };

      const nextWorkspaceLevel = workspaceLevels.get(pkg.id);
      if (nextWorkspaceLevel) {
        nextContext.workspaceLevel = nextWorkspaceLevel;
        nextContext.isDirectDependency = true;
      } else if (pkg.packageType === PackageType.PORTAL) {
        nextContext.isDirectDependency = true;
      } else {
        nextContext.isDirectDependency = false;
      }

      return nextContext;
    },
    graph,
    { workspaceLevel: 1, isDirectDependency: true }
  );

  const pkgIds = Array.from(packageMetrics.keys());
  pkgIds.sort((id1, id2) => {
    const pkg1 = packageMetrics.get(id1);
    const pkg2 = packageMetrics.get(id2);
    if (pkg2.directDependencyLevel !== pkg1.directDependencyLevel) {
      return pkg1.directDependencyLevel - pkg2.directDependencyLevel;
    } else if (pkg2.peerCount !== pkg1.peerCount) {
      return pkg2.peerCount - pkg1.peerCount;
    } else if (pkg2.parents.size !== pkg1.parents.size) {
      return pkg2.parents.size - pkg1.parents.size;
    } else {
      return id2 > id1 ? -1 : 1;
    }
  });

  for (const pkgId of pkgIds) {
    const pkgName = getPackageName(pkgId);
    let priorityList = priorities.get(pkgName);
    if (!priorityList) {
      priorityList = [];
      priorities.set(pkgName, priorityList);
    }
    priorityList.push(pkgId);
  }

  return priorities;
};
