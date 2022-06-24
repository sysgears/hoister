import { traverseDependencies } from './traversal';
import { getPackageName } from './parse';
import { getHoistPriorities, HoistPriorities } from './priority';

export type PackageId = string & { _packageId: true };
export type PackageName = string & { _packageName: true };
export enum PackageType {
  PORTAL,
}

export const PackageId = {
  root: '.' as PackageId,
};

export type Package = {
  id: PackageId;
  dependencies?: Package[];
  workspaces?: Package[];
  peerNames?: PackageName[];
  packageType?: PackageType;
};

export type Graph = {
  id: PackageId;
  dependencies?: Map<PackageName, Graph>;
  hoistedTo?: Map<PackageName, Graph>;
  workspaces?: Map<PackageName, Graph>;
  peerNames?: Set<PackageName>;
  packageType?: PackageType;
};

const EMPTY_MAP = new Map();

const decoupleNode = (graph: Graph): Graph => {
  if (graph['__decoupled']) return graph;

  const clone: Graph = { id: graph.id };

  if (graph.packageType) {
    clone.packageType = graph.packageType;
  }

  if (graph.peerNames) {
    clone.peerNames = new Set(graph.peerNames);
  }

  if (graph.workspaces) {
    clone.workspaces = new Map(graph.workspaces);
  }

  if (graph.dependencies) {
    clone.dependencies = new Map(graph.dependencies);
    const nodeName = getPackageName(graph.id);
    const selfNameDep = graph.dependencies.get(nodeName);
    if (selfNameDep === graph) {
      clone.dependencies.set(nodeName, clone);
    }
  }

  Object.defineProperty(clone, '__decoupled', { value: true });

  return clone;
};

export const toGraph = (rootPkg: Package): Graph => {
  const graph: Graph = {
    id: rootPkg.id,
  };

  const seen = new Set<Package>();

  const visitDependency = (
    pkg: Package,
    parentNode: Graph,
    parentNodes: Map<PackageId, Graph>,
    { isWorkspaceDep }: { isWorkspaceDep: boolean }
  ) => {
    const isSeen = seen.has(pkg);
    const newNode = pkg === rootPkg ? graph : parentNodes.get(pkg.id) || { id: pkg.id };
    seen.add(pkg);

    if (pkg.packageType) {
      newNode.packageType = pkg.packageType;
    }

    if (pkg.peerNames) {
      newNode.peerNames = new Set(pkg.peerNames);
    }

    if (pkg !== rootPkg) {
      const name = getPackageName(pkg.id);
      if (isWorkspaceDep) {
        parentNode.workspaces = parentNode.workspaces || new Map();
        parentNode.workspaces.set(name, newNode);
      } else {
        parentNode.dependencies = parentNode.dependencies || new Map();
        parentNode.dependencies.set(name, newNode);
      }
    }

    if (!isSeen) {
      const nextParentNodes = new Map([...parentNodes.entries(), [pkg.id, newNode]]);
      for (const workspaceDep of pkg.workspaces || []) {
        visitDependency(workspaceDep, newNode, nextParentNodes, { isWorkspaceDep: true });
      }

      for (const dep of pkg.dependencies || []) {
        visitDependency(dep, newNode, nextParentNodes, { isWorkspaceDep: false });
      }
    }
  };

  visitDependency(rootPkg, graph, new Map(), { isWorkspaceDep: true });

  // console.log(
  //   'pkg',
  //   require('util').inspect(rootPkg, false, null),
  //   'graph',
  //   require('util').inspect(graph, false, null)
  // );

  return graph;
};

export const toPackage = (graph: Graph): Package => {
  const rootPkg: Package = { id: graph.id };

  const visitDependency = (graphPath: Graph[], parentPkg: Package, { isWorkspaceDep }: { isWorkspaceDep: boolean }) => {
    const node = graphPath[graphPath.length - 1];
    const newPkg = graphPath.length === 1 ? parentPkg : { id: node.id };

    if (node.packageType) {
      newPkg.packageType = node.packageType;
    }

    if (node.peerNames) {
      newPkg.peerNames = Array.from(node.peerNames);
    }

    if (graphPath.length > 1) {
      if (isWorkspaceDep) {
        parentPkg.workspaces = parentPkg.workspaces || [];
        parentPkg.workspaces.push(newPkg);
      } else {
        parentPkg.dependencies = parentPkg.dependencies || [];
        parentPkg.dependencies.push(newPkg);
      }
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        const sortedEntries = Array.from(node.workspaces.entries()).sort((x1, x2) =>
          x1[0] === x2[0] ? 0 : x1[0] < x2[0] ? -1 : 1
        );

        for (const [, depWorkspace] of sortedEntries) {
          graphPath.push(depWorkspace);
          visitDependency(graphPath, newPkg, { isWorkspaceDep: true });
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        const sortedEntries = Array.from(node.dependencies.entries()).sort((x1, x2) =>
          x1[0] === x2[0] ? 0 : x1[0] < x2[0] ? -1 : 1
        );

        for (const [, dep] of sortedEntries) {
          graphPath.push(dep);
          visitDependency(graphPath, newPkg, { isWorkspaceDep: false });
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([graph], rootPkg, { isWorkspaceDep: true });

  return rootPkg;
};

type HoistQueue = Array<Array<PackageId[]>>;

const hoistDependency = (
  graphPath: Graph[],
  hoistPriorities: HoistPriorities,
  currentPriorityDepth: number,
  hoistQueue?: HoistQueue
) => {
  // console.log(
  //   currentPriorityDepth === 0 ? 'visit' : 'revisit',
  //   graphPath.map((x) => x.id)
  // );
  for (let rootPkgIdx = 0; rootPkgIdx < graphPath.length - 2; rootPkgIdx++) {
    let rootPkg = graphPath[rootPkgIdx];
    const dep = graphPath[graphPath.length - 1];
    const depName = getPackageName(dep.id);
    let isHoistable = false;
    const priorityIds = hoistPriorities.get(depName);
    if (priorityIds) {
      const rootDep = rootPkg.dependencies?.get(depName);
      const depPriorityDepth = priorityIds.indexOf(dep.id);
      const isDepTurn = depPriorityDepth === currentPriorityDepth;
      if (!rootDep) {
        isHoistable = isDepTurn;
      } else {
        isHoistable = rootDep.id === dep.id;
      }
      if (hoistQueue && !rootDep && !isDepTurn) {
        hoistQueue[depPriorityDepth].push(graphPath.map((x) => x.id));
        break;
      }

      if (isHoistable) {
        for (const [hoistedName, hoistedTo] of dep.hoistedTo || EMPTY_MAP) {
          const originalId = hoistedTo.dependencies.get(hoistedName);
          let availableId: PackageId | undefined = undefined;
          for (let idx = 0; idx < rootPkgIdx; idx++) {
            availableId = graphPath[idx].dependencies?.get(hoistedName)?.id;
          }
          isHoistable = availableId === originalId;
        }
      }
    }

    if (isHoistable) {
      for (let idx = 1; idx < graphPath.length - 1; idx++) {
        const parentPkg = graphPath[idx - 1];
        const pkg = graphPath[idx];
        const pkgName = getPackageName(pkg.id);
        if (!pkg['__decoupled']) {
          const newPkg = decoupleNode(pkg);
          graphPath[idx] = newPkg;
          if (parentPkg.dependencies && parentPkg.dependencies.get(pkgName) === pkg) {
            parentPkg.dependencies.set(pkgName, newPkg);
          } else if (parentPkg.workspaces && parentPkg.workspaces.get(pkgName) === pkg) {
            parentPkg.workspaces.set(pkgName, newPkg);
          } else {
            throw new Error(`Assertion: Unable to find decoupled node ${pkg.id} in ${parentPkg.id}`);
          }
        }
      }
      rootPkg = graphPath[rootPkgIdx];
      const parentPkg = graphPath[graphPath.length - 2];
      if (parentPkg.dependencies) {
        parentPkg.dependencies.delete(depName);
        if (parentPkg.dependencies.size === 0) {
          delete parentPkg.dependencies;
        }
        if (!parentPkg.hoistedTo) {
          parentPkg.hoistedTo = new Map();
        }
        parentPkg.hoistedTo.set(depName, rootPkg);
      }
      if (!rootPkg.dependencies) {
        rootPkg.dependencies = new Map();
      }
      if (!rootPkg.dependencies.has(depName)) {
        rootPkg.dependencies.set(depName, dep);
      }
      // console.log(
      //   graphPath.map((x) => x.id),
      //   'hoist',
      //   dep.id,
      //   'into',
      //   rootPkg.id,
      //   'result:\n',
      //   require('util').inspect(graphPath[0], false, null)
      // );
      break;
    }
  }
};

type Options = {
  dump: boolean;
};

export const hoist = (pkg: Package, opts?: Options): Package => {
  const graph = toGraph(pkg);
  const options = opts || { dump: false };

  const priorities = getHoistPriorities(graph);
  let maxPriorityDepth = 0;
  for (const priorityIds of priorities.values()) {
    maxPriorityDepth = Math.max(maxPriorityDepth, priorityIds.length);
  }
  const hoistQueue: HoistQueue = [];
  for (let idx = 0; idx < maxPriorityDepth; idx++) {
    hoistQueue.push([]);
  }
  let priorityDepth = 0;

  // console.log('input graph:', require('util').inspect(graph, false, null));
  // console.log('priorities:', require('util').inspect(priorities, false, null));

  traverseDependencies(
    (graphPath) => {
      if (graphPath.length > 2) {
        hoistDependency(graphPath, priorities, priorityDepth, hoistQueue);
      }
    },
    graph,
    null
  );

  for (priorityDepth = 1; priorityDepth < maxPriorityDepth; priorityDepth++) {
    for (const graphPathIds of hoistQueue[priorityDepth]) {
      const graphPath: Graph[] = [graph];
      let parentPkg = graphPath[graphPath.length - 1];
      for (const id of graphPathIds.slice(1)) {
        const name = getPackageName(id);
        const hoistedTo = parentPkg.hoistedTo?.get(name);
        if (hoistedTo && parentPkg.workspaces?.get(name)?.id !== id) {
          parentPkg = hoistedTo;
          let idx;
          let foundHoistParent = false;
          for (idx = 0; idx < graphPath.length - 1; idx++) {
            if (graphPath[idx].id === hoistedTo.id) {
              foundHoistParent = true;
              break;
            }
          }
          if (!foundHoistParent) {
            throw new Error(`Assertion: Unable to find hoist parent ${hoistedTo.id} for ${id}`);
          }
          graphPath.splice(idx + 1);
        }
        const parentDep = parentPkg.dependencies?.get(name);
        const parentWorkspaceDep = parentPkg.workspaces?.get(name);
        if (parentDep?.id === id) {
          graphPath.push(parentDep);
        } else if (parentWorkspaceDep?.id === id) {
          graphPath.push(parentWorkspaceDep);
        } else {
          throw new Error(
            `Assertion: Unable to find child node ${id} in ${parentPkg.id}` +
              (hoistedTo ? `which were previously hoisted from ${graphPath[graphPath.length - 1].id}` : ``)
          );
        }
        parentPkg = graphPath[graphPath.length - 1];
      }
      hoistDependency(graphPath, priorities, priorityDepth);
    }
  }

  if (options.dump) {
    console.log(require('util').inspect(graph, false, null));
  }

  return toPackage(graph);
};
