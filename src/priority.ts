import { PackageName, PackageId, PackageType, WorkGraph } from '.';
import { getPackageName } from './parse';

export type HoistPriorities = Map<PackageName, PackageId[]>;
export type DetailedHoistPriorities = Map<PackageName, PackageId[]>;
export type Usages = Map<PackageId, Set<PackageId>>;
export type Children = Map<PackageId, number>;

type PriorityOptions = {
  trace: boolean;
};

export const getUsages = (graph: WorkGraph, opts?: PriorityOptions): Usages => {
  const options = opts || { trace: false };
  const packageUsages = new Map();

  const visitDependency = (graphPath: WorkGraph[]) => {
    const pkg = graphPath[graphPath.length - 1];
    let usedBy = packageUsages.get(pkg.id);
    const isSeen = !!usedBy;
    if (!usedBy) {
      usedBy = new Set();
      packageUsages.set(pkg.id, usedBy);
    }
    if (graphPath.length > 1) {
      usedBy.add(graphPath[graphPath.length - 2].id);
    }

    if (pkg.peerNames) {
      for (const peerName of pkg.peerNames) {
        let peerDep;
        for (let idx = graphPath.length - 2; idx >= 0; idx--) {
          peerDep = graphPath[idx].dependencies?.get(peerName);
          if (peerDep) {
            let usedBy = packageUsages.get(peerDep.id);
            if (!usedBy) {
              usedBy = new Set();
              packageUsages.set(peerDep.id, usedBy);
            }
            usedBy.add(pkg.id);
            break;
          }
        }
      }
    }

    if (!isSeen) {
      if (pkg.workspaces) {
        for (const dep of pkg.workspaces.values()) {
          graphPath.push(dep);
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (pkg.dependencies) {
        for (const dep of pkg.dependencies.values()) {
          graphPath.push(dep);
          visitDependency(graphPath);
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([graph]);

  if (options.trace) {
    console.log(require('util').inspect(packageUsages, false, null));
  }

  return packageUsages;
};

export const getChildren = (graph: WorkGraph, opts?: PriorityOptions): Children => {
  const options = opts || { trace: false };
  const children = new Map();

  const visitDependency = (graphPath: { node: WorkGraph; isWorkspace: boolean }[]) => {
    const pkg = graphPath[graphPath.length - 1].node;
    const pkgPriority = children.get(pkg.id);
    const isSeen = typeof pkgPriority !== 'undefined';
    if (graphPath.length > 1) {
      const parent = graphPath[graphPath.length - 2];
      let priority = 0;
      if (parent.isWorkspace) {
        priority = 1;
      } else if (parent.node.packageType === PackageType.PORTAL) {
        priority = 2;
      }
      children.set(pkg.id, Math.max(pkgPriority || 0, priority));
    }

    if (!isSeen) {
      if (pkg.workspaces) {
        for (const dep of pkg.workspaces.values()) {
          graphPath.push({ node: dep, isWorkspace: true });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (pkg.dependencies) {
        for (const dep of pkg.dependencies.values()) {
          graphPath.push({ node: dep, isWorkspace: false });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([{ node: graph, isWorkspace: true }]);

  if (options.trace) {
    console.log(require('util').inspect(children, false, null));
  }

  return children;
};

export const getPriorities = (usages: Usages, children: Children): HoistPriorities => {
  const priorities = new Map();

  const pkgIds = Array.from(children.keys());
  pkgIds.sort((id1, id2) => {
    const priority1 = children.get(id1)!;
    const priority2 = children.get(id2)!;
    if (priority2 !== priority1) {
      return priority2 - priority1;
    } else {
      const usage1 = usages.get(id1)!.size;
      const usage2 = usages.get(id2)!.size;
      if (usage2 !== usage1) {
        return usage2 - usage1;
      } else {
        return id2 > id1 ? -1 : 1;
      }
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
    graphPath: WorkGraph[],
    options: { workspaceLevel: number; isDirectDependency: boolean }
  ) => {
    const pkg = graphPath[graphPath.length - 1];
    const isSeen = seen.has(pkg);
    seen.add(pkg);

    let metrics = packageMetrics.get(pkg.id);
    if (!metrics) {
      metrics = {
        directDependencyLevel: maxWorkspaceLevel + 1,
        usedBy: new Set(),
      };
      packageMetrics.set(pkg.id, metrics);
    }

    if (options.isDirectDependency && options.workspaceLevel < metrics.directDependencyLevel) {
      metrics.directDependencyLevel = options.workspaceLevel;
    }
    if (graphPath.length > 1) {
      metrics.usedBy.add(graphPath[graphPath.length - 2]);
    }

    if (pkg.peerNames) {
      for (const peerName of pkg.peerNames) {
        let peerDep;
        for (let idx = graphPath.length - 2; idx >= 0; idx--) {
          peerDep = graphPath[idx].dependencies?.get(peerName);
          if (peerDep) {
            let metrics = packageMetrics.get(peerDep.id);
            if (!metrics) {
              metrics = {
                directDependencyLevel: maxWorkspaceLevel + 1,
                usedBy: new Set(),
              };
              packageMetrics.set(peerDep.id, metrics);
            }
            metrics.usedBy.add(pkg);
            break;
          }
        }
      }
    }

    let workspaceLevel = options.workspaceLevel;
    let isDirectDependency;
    const nextWorkspaceLevel = workspaceLevels.get(pkg.id);
    if (nextWorkspaceLevel) {
      workspaceLevel = nextWorkspaceLevel;
      isDirectDependency = true;
    } else if (pkg.packageType === PackageType.PORTAL) {
      isDirectDependency = true;
    } else {
      isDirectDependency = false;
    }

    if (!isSeen) {
      if (pkg.workspaces) {
        for (const dep of pkg.workspaces.values()) {
          graphPath.push(dep);
          visitDependency(graphPath, { workspaceLevel, isDirectDependency });
          graphPath.pop();
        }
      }

      if (pkg.dependencies) {
        for (const dep of pkg.dependencies.values()) {
          graphPath.push(dep);
          visitDependency(graphPath, { workspaceLevel, isDirectDependency });
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([graph], { workspaceLevel: 1, isDirectDependency: true });

  const pkgIds = Array.from(packageMetrics.keys());
  pkgIds.sort((id1, id2) => {
    const pkg1 = packageMetrics.get(id1);
    const pkg2 = packageMetrics.get(id2);
    if (pkg2.directDependencyLevel !== pkg1.directDependencyLevel) {
      return pkg1.directDependencyLevel - pkg2.directDependencyLevel;
    } else if (pkg2.usedBy.size !== pkg1.usedBy.size) {
      return pkg2.usedBy.size - pkg1.usedBy.size;
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
    console.log('workspace levels:', require('util').inspect(workspaceLevels, false, null));
    console.log('metrics:', require('util').inspect(packageMetrics, false, 3));
    console.log('priorities', require('util').inspect(priorities, false, null));
  }

  return priorities;
};
