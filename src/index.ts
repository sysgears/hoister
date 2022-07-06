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
  firm: boolean;
};

const EMPTY_MAP = new Map();

const decoupleNode = (graph: Graph): Graph => {
  if (graph['__decoupled']) return graph;

  const clone: Graph = { id: graph.id, firm: graph.firm };

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
    firm: true,
  };

  Object.defineProperty(graph, '__decoupled', { value: true });

  const seen = new Set<Package>();

  const visitDependency = (
    pkg: Package,
    parentNode: Graph,
    parentNodes: Map<PackageId, Graph>,
    { isWorkspaceDep }: { isWorkspaceDep: boolean }
  ) => {
    const isSeen = seen.has(pkg);
    const newNode = pkg === rootPkg ? graph : parentNodes.get(pkg.id) || { id: pkg.id, firm: false };
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

type QueueElement = { graphPath: PackageId[]; depName: PackageName };
type HoistQueue = Array<QueueElement[]>;

enum Hoistable {
  LATER = 'LATER',
  YES = 'YES',
  NO = 'NO',
  DEPENDS = 'DEPENDS',
}

type HoistVerdict =
  | {
      isHoistable: Hoistable.LATER;
      priorityDepth: number;
    }
  | {
      isHoistable: Hoistable.YES;
      newParentIndex: number;
    }
  | {
      isHoistable: Hoistable.NO;
    }
  | {
      isHoistable: Hoistable.DEPENDS;
      dependsOn: Set<PackageName>;
      newParentIndex: number;
    };

const getHoistVerdict = (
  graphPath: Graph[],
  depName: PackageName,
  hoistPriorities: HoistPriorities,
  currentPriorityDepth: number
): HoistVerdict => {
  const parentPkg = graphPath[graphPath.length - 1];
  const dep = parentPkg.dependencies!.get(depName)!;
  const priorityIds = hoistPriorities.get(depName)!;
  let isHoistable = Hoistable.YES;
  const dependsOn = new Set<PackageName>();
  let priorityDepth;
  let newParentIndex;

  let waterMark;
  for (waterMark = graphPath.length - 2; waterMark > 0; waterMark--) {
    let newParentIdx = waterMark;
    const newParentPkg = graphPath[waterMark];
    const hoistedParent = newParentPkg?.hoistedTo?.get(depName);
    if (hoistedParent) {
      newParentIdx = graphPath.indexOf(hoistedParent);
    }

    const newParentDep = newParentPkg.dependencies?.get(depName);
    if (newParentDep && newParentDep.id !== dep.id) {
      waterMark = newParentIdx + 1;
      const waterMarkParent = graphPath[waterMark + 1];
      if (waterMark === graphPath.length - 1) {
        isHoistable = Hoistable.NO;
      } else if (!waterMarkParent.firm) {
        isHoistable = Hoistable.LATER;
        priorityDepth = hoistPriorities.get(getPackageName(waterMarkParent.id))!.indexOf(waterMarkParent.id);
      }
      break;
    }
  }

  if (isHoistable === Hoistable.YES) {
    // Check require promise
    for (newParentIndex = waterMark; newParentIndex < graphPath.length - 1; newParentIndex++) {
      const newParentPkg = graphPath[newParentIndex];

      const newParentDep = newParentPkg.dependencies?.get(depName) || newParentPkg?.hoistedTo?.get(depName);
      priorityDepth = priorityIds.indexOf(dep.id);
      const isDepTurn = priorityDepth === currentPriorityDepth;
      if (!newParentDep) {
        isHoistable = isDepTurn ? Hoistable.YES : Hoistable.LATER;
      } else {
        isHoistable = newParentDep.id === dep.id ? Hoistable.YES : Hoistable.NO;
      }

      if (isHoistable === Hoistable.YES) {
        for (const [hoistedName, hoistedTo] of dep.hoistedTo || EMPTY_MAP) {
          const originalId = hoistedTo.dependencies.get(hoistedName);
          let availableId: PackageId | undefined = undefined;
          for (let idx = 0; idx < newParentIndex; idx++) {
            availableId = graphPath[idx].dependencies?.get(hoistedName)?.id;
          }

          isHoistable = availableId === originalId ? Hoistable.YES : Hoistable.NO;

          if (isHoistable === Hoistable.NO) break;
        }
      }

      if (isHoistable !== Hoistable.NO) {
        break;
      }
    }
  }

  // Check peer dependency promise
  if (isHoistable === Hoistable.YES) {
    if (dep.peerNames) {
      for (const peerName of dep.peerNames) {
        let peerParent;
        let isHoistedPeerDep;
        let peerParentIdx;
        for (peerParentIdx = graphPath.length - 1; peerParentIdx >= 0; peerParentIdx--) {
          if (graphPath[peerParentIdx].dependencies?.has(peerName)) {
            isHoistedPeerDep = false;
            peerParent = graphPath[peerParentIdx];
          } else {
            peerParent = graphPath[peerParentIdx].hoistedTo?.get(peerName);
            if (peerParent) {
              peerParentIdx = graphPath.indexOf(peerParent);
              isHoistedPeerDep = true;
            }
          }

          if (peerParent) break;
        }

        if (peerParent) {
          if (isHoistedPeerDep) {
            newParentIndex = Math.max(newParentIndex, peerParentIdx);
          } else {
            const depPriority = priorityIds.indexOf(dep.id);
            if (depPriority <= currentPriorityDepth) {
              if (peerParentIdx === graphPath.length - 1) {
                // Might be a cyclic peer dependency, mark that we depend on it
                isHoistable = Hoistable.DEPENDS;
                dependsOn.add(peerName);
              } else {
                newParentIndex = Math.max(newParentIndex, peerParentIdx);
              }
            } else {
              // Should be hoisted later, wait
              isHoistable = Hoistable.LATER;
              priorityDepth = Math.max(priorityDepth, depPriority);
            }
          }
        }
      }
    }
  }

  if (isHoistable === Hoistable.LATER) {
    return { isHoistable, priorityDepth };
  } else if (isHoistable === Hoistable.DEPENDS) {
    return { isHoistable, dependsOn, newParentIndex };
  } else if (isHoistable === Hoistable.YES) {
    return { isHoistable, newParentIndex };
  } else {
    return { isHoistable };
  }
};

/**
 * Gets regular node dependencies only and sorts them in the order so that
 * peer dependencies come before the dependency that rely on them.
 *
 * @param node graph node
 * @returns sorted regular dependencies
 */
const getSortedRegularDependencies = (node: Graph, originalDepNames: Set<PackageName>): Set<PackageName> => {
  const depNames: Set<PackageName> = new Set();

  const addDep = (depName: PackageName, seenDeps = new Set()) => {
    if (seenDeps.has(depName)) return;
    seenDeps.add(depName);
    const dep = node.dependencies!.get(depName)!;

    if (dep.peerNames) {
      for (const peerName of dep.peerNames) {
        if (originalDepNames.has(peerName) && !node.peerNames?.has(peerName)) {
          const peerDep = node.dependencies!.get(peerName);
          if (peerDep && !depNames.has(peerName)) {
            addDep(peerName, seenDeps);
          }
        }
      }
    }

    depNames.add(depName);
  };

  if (node.dependencies) {
    for (const depName of originalDepNames) {
      if (!node.peerNames?.has(depName)) {
        addDep(depName);
      }
    }
  }

  return depNames;
};

const hoistDependencies = (
  graphPath: Graph[],
  hoistPriorities: HoistPriorities,
  currentPriorityDepth: number,
  depNames: Set<PackageName>,
  options: HoistOptions,
  hoistQueue?: HoistQueue
) => {
  const parentPkg = graphPath[graphPath.length - 1];

  const sortedDepNames = depNames.size === 1 ? depNames : getSortedRegularDependencies(parentPkg, depNames);
  const peerDependants = new Map<PackageName, Set<PackageName>>();
  const verdictMap = new Map<PackageName, HoistVerdict>();
  for (const depName of sortedDepNames) {
    verdictMap.set(depName, getHoistVerdict(graphPath, depName, hoistPriorities, currentPriorityDepth));
  }
  const originalVerdictMap = new Map(verdictMap);

  for (const [dependerName, verdict] of verdictMap) {
    if (verdict.isHoistable === Hoistable.DEPENDS) {
      for (const dependeeName of verdict.dependsOn) {
        const dependants = peerDependants.get(dependeeName) || new Set();
        dependants.add(dependerName);
        peerDependants.set(dependeeName, dependants);
      }
    }
  }

  for (const [nodeName, verdict] of verdictMap) {
    const dependants = peerDependants.get(nodeName);
    if (dependants) {
      for (const dependantName of dependants) {
        const originalVerdict = verdictMap.get(dependantName)!;
        if (
          originalVerdict.isHoistable === Hoistable.DEPENDS &&
          (verdict.isHoistable === Hoistable.DEPENDS || verdict.isHoistable === Hoistable.YES)
        ) {
          verdictMap.set(dependantName, {
            isHoistable: verdict.isHoistable,
            newParentIndex: Math.max(originalVerdict.newParentIndex, verdict.newParentIndex),
            dependsOn: originalVerdict.dependsOn,
          });
        } else {
          verdictMap.set(dependantName, verdict);
        }
      }
    }
  }

  if (options.trace) {
    console.log(
      currentPriorityDepth === 0 ? 'visit' : 'revisit',
      graphPath.map((x) => x.id),
      originalVerdictMap,
      verdictMap
    );
  }

  for (const depName of sortedDepNames) {
    const dep = parentPkg.dependencies!.get(depName)!;
    const verdict = verdictMap.get(depName)!;
    if (verdict.isHoistable !== Hoistable.LATER) {
      dep.firm = true;
    }

    if (verdict.isHoistable === Hoistable.YES || verdict.isHoistable === Hoistable.DEPENDS) {
      const rootPkg = graphPath[verdict.newParentIndex];
      const parentPkg = graphPath[graphPath.length - 1];
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

      if (options.trace) {
        console.log(
          graphPath.map((x) => x.id),
          'hoist',
          dep.id,
          'into',
          rootPkg.id,
          'result:\n',
          require('util').inspect(graphPath[0], false, null)
        );
      }
    } else if (verdict.isHoistable === Hoistable.LATER) {
      if (options.trace) {
        console.log('queue', graphPath.map((x) => x.id).concat([dep.id]));
      }

      hoistQueue![verdict.priorityDepth].push({ graphPath: graphPath.map((x) => x.id), depName });
    }
  }
};

type HoistOptions = {
  trace: boolean;
};

export const hoist = (pkg: Package, opts?: HoistOptions): Package => {
  const graph = toGraph(pkg);
  const options = opts || { trace: false };

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

  const visitParent = (graphPath: Graph[]) => {
    const node = graphPath[graphPath.length - 1];

    if (node.dependencies) {
      for (const [depName, dep] of node.dependencies) {
        const newDep = decoupleNode(dep);
        node.dependencies!.set(depName, newDep);
        if (graphPath.length === 1) {
          newDep.firm = true;
        }
      }
    }

    if (node.workspaces) {
      for (const [workspaceName, workspaceDep] of node.workspaces) {
        const newDep = decoupleNode(workspaceDep);
        node.workspaces!.set(workspaceName, newDep);
        newDep.firm = true;
      }
    }

    if (graphPath.length > 1 && node.dependencies) {
      hoistDependencies(graphPath, priorities, priorityDepth, new Set(node.dependencies.keys()), options, hoistQueue);
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        for (const depWorkspace of node.workspaces.values()) {
          graphPath.push(depWorkspace);
          visitParent(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          if (dep.id !== node.id) {
            graphPath.push(dep);
            visitParent(graphPath);
            graphPath.pop();
          }
        }
      }
    }
  };

  visitParent([graph]);

  for (priorityDepth = 1; priorityDepth < maxPriorityDepth; priorityDepth++) {
    while (hoistQueue[priorityDepth].length > 0) {
      const queueElement = hoistQueue[priorityDepth].shift()!;
      const graphPath: Graph[] = [graph];
      let parentPkg = graphPath[graphPath.length - 1];
      for (const id of queueElement.graphPath.slice(1)) {
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
      hoistDependencies(graphPath, priorities, priorityDepth, new Set([queueElement.depName]), options);
    }
  }

  if (options.trace) {
    console.log(require('util').inspect(graph, false, null));
  }

  return toPackage(graph);
};
