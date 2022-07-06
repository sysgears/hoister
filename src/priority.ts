import { PackageName, PackageId, PackageType, WorkGraph } from '.';
import { getPackageName } from './parse';

export type HoistPriorities = Map<PackageName, PackageId[]>;

const EMPTY_SET = new Set();

type PriorityOptions = {
  trace: boolean;
};

export const getHoistPriorities = (graph: WorkGraph, opts?: PriorityOptions): HoistPriorities => {
  const options = opts || { trace: false };

  const priorities = new Map();
  const workspaceLevels = new Map<PackageId, number>();
  let maxWorkspaceLevel = 0;
  const packageMetrics = new Map();

  const seenWorkspaces = new Set();

  const visitWorkspace = (workspace: WorkGraph, workspaceLevel: number) => {
    if (seenWorkspaces.has(workspace)) return;
    seenWorkspaces.add(workspace);

    if (workspaceLevel > maxWorkspaceLevel) {
      maxWorkspaceLevel = workspaceLevel;
    }
    workspaceLevels.set(workspace.id, workspaceLevel);

    if (workspace.workspaces) {
      for (const dep of workspace.workspaces.values()) {
        visitWorkspace(dep, workspaceLevel + 1);
      }
    }
  };

  visitWorkspace(graph, 1);

  const seen = new Set();
  const visitDependency = (
    pkg: WorkGraph,
    parentPkg: WorkGraph,
    options: { workspaceLevel: number; isDirectDependency: boolean }
  ) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);

    let metrics = packageMetrics.get(pkg.id);
    if (!metrics) {
      metrics = {
        directDependencyLevel: maxWorkspaceLevel + 1,
        parents: new Set(),
      };
      packageMetrics.set(pkg.id, metrics);
    }

    if (options.isDirectDependency && options.workspaceLevel < metrics.directDependencyLevel) {
      metrics.directDependencyLevel = options.workspaceLevel;
    }
    if (pkg !== graph) {
      metrics.parents.add(parentPkg);
    }

    let workspaceLevel, isDirectDependency;
    const nextWorkspaceLevel = workspaceLevels.get(pkg.id);
    if (nextWorkspaceLevel) {
      workspaceLevel = nextWorkspaceLevel;
      isDirectDependency = true;
    } else if (pkg.packageType === PackageType.PORTAL) {
      isDirectDependency = true;
    } else {
      isDirectDependency = false;
    }

    if (pkg.workspaces) {
      for (const dep of pkg.workspaces.values()) {
        visitDependency(dep, pkg, { workspaceLevel, isDirectDependency });
      }
    }

    if (pkg.dependencies) {
      for (const dep of pkg.dependencies.values()) {
        visitDependency(dep, pkg, { workspaceLevel, isDirectDependency });
      }
    }
  };

  visitDependency(graph, graph, { workspaceLevel: 1, isDirectDependency: true });

  const pkgIds = Array.from(packageMetrics.keys());
  pkgIds.sort((id1, id2) => {
    const pkg1 = packageMetrics.get(id1);
    const pkg2 = packageMetrics.get(id2);
    if (pkg2.directDependencyLevel !== pkg1.directDependencyLevel) {
      return pkg1.directDependencyLevel - pkg2.directDependencyLevel;
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

  if (options.trace) {
    console.log('metrics:', require('util').inspect(packageMetrics, false, 3));
    console.log('priorities', require('util').inspect(priorities, false, null));
  }

  return priorities;
};
