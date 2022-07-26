import { getPackageName } from './parse';
import { getChildren, getPriorities, getUsages, HoistPriorities } from './priority';

export type PackageId = string & { _packageId: true };
export type PackageName = string & { _packageName: true };
export enum PackageType {
  PORTAL = 'PORTAL',
}

export enum CheckType {
  FINAL = 'FINAL',
}

export const PackageId = {
  root: '.' as PackageId,
};

export type Graph = {
  id: string;
  alias?: string;
  dependencies?: Graph[];
  workspaces?: Graph[];
  peerNames?: string[];
  packageType?: PackageType;
  wall?: string[];
};

export type WorkGraph = {
  id: PackageId;
  dependencies?: Map<PackageName, WorkGraph>;
  dependants?: Map<WorkGraph, Set<PackageName>>;
  workspaces?: Map<PackageName, WorkGraph>;
  peerNames?: Set<PackageName>;
  packageType?: PackageType;
  priority?: number;
  wall?: Set<PackageName>;
  originalParent?: WorkGraph;
  newParent?: WorkGraph;
};

const decoupleNode = (node: WorkGraph): WorkGraph => {
  if (node['__decoupled']) return node;

  const clone: WorkGraph = { id: node.id };

  if (node.packageType) {
    clone.packageType = node.packageType;
  }

  if (node.peerNames) {
    clone.peerNames = new Set(node.peerNames);
  }

  if (node.wall) {
    clone.wall = node.wall;
  }

  if (node.workspaces) {
    clone.workspaces = new Map(node.workspaces);
  }

  if (node.dependencies) {
    clone.dependencies = new Map(node.dependencies);
    const nodeName = getPackageName(node.id);
    const selfNameDep = node.dependencies.get(nodeName);
    if (selfNameDep === node) {
      clone.dependencies.set(nodeName, clone);
    }
  }

  Object.defineProperty(clone, '__decoupled', { value: true });

  return clone;
};

const getAliasedId = (pkg: Graph): PackageId =>
  !pkg.alias ? (pkg.id as PackageId) : (`${pkg.alias}@>${pkg.id}` as PackageId);

const fromAliasedId = (aliasedId: PackageId): { alias?: PackageName; id: PackageId } => {
  const alias = getPackageName(aliasedId);
  const idIndex = aliasedId.indexOf('@>', alias.length);
  return idIndex < 0 ? { id: aliasedId } : { alias, id: aliasedId.substring(idIndex + 2) as PackageId };
};

export const toWorkGraph = (rootPkg: Graph): WorkGraph => {
  const graph: WorkGraph = {
    id: getAliasedId(rootPkg),
  };

  Object.defineProperty(graph, '__decoupled', { value: true });

  const seen = new Map<Graph, WorkGraph>();

  const visitDependency = (pkg: Graph, parentNode: WorkGraph, { isWorkspaceDep }: { isWorkspaceDep: boolean }) => {
    const aliasedId = getAliasedId(pkg);
    const seenNode = seen.get(pkg);
    const newNode = pkg === rootPkg ? graph : seenNode || { id: aliasedId };
    seen.set(pkg, newNode);

    if (pkg.packageType) {
      newNode.packageType = pkg.packageType;
    }

    if (pkg.peerNames) {
      newNode.peerNames = new Set(pkg.peerNames as PackageName[]);
    }

    if (pkg.wall) {
      newNode.wall = new Set(pkg.wall as PackageName[]);
    }

    if (pkg !== rootPkg) {
      const name = getPackageName(newNode.id);
      if (isWorkspaceDep) {
        parentNode.workspaces = parentNode.workspaces || new Map();
        parentNode.workspaces.set(name, newNode);
      } else {
        parentNode.dependencies = parentNode.dependencies || new Map();
        parentNode.dependencies.set(name, newNode);
      }
    }

    if (!seenNode) {
      for (const workspaceDep of pkg.workspaces || []) {
        visitDependency(workspaceDep, newNode, { isWorkspaceDep: true });
      }

      for (const dep of pkg.dependencies || []) {
        visitDependency(dep, newNode, { isWorkspaceDep: false });
      }
    }
  };

  visitDependency(rootPkg, graph, { isWorkspaceDep: true });

  return graph;
};

const fromWorkGraph = (graph: WorkGraph): Graph => {
  const rootPkg: Graph = { id: fromAliasedId(graph.id).id };

  const visitDependency = (
    graphPath: WorkGraph[],
    parentPkg: Graph,
    { isWorkspaceDep }: { isWorkspaceDep: boolean }
  ) => {
    const node = graphPath[graphPath.length - 1];
    let newPkg;
    if (graphPath.length === 1) {
      newPkg = parentPkg;
    } else {
      const { alias, id } = fromAliasedId(node.id);
      newPkg = { id };
      if (alias) {
        newPkg.alias = alias;
      }
    }

    if (node.packageType) {
      newPkg.packageType = node.packageType;
    }

    if (node.peerNames) {
      newPkg.peerNames = Array.from(node.peerNames);
    }

    if (node.wall) {
      newPkg.wall = Array.from(node.wall);
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
          if (!dep.newParent || dep.newParent === node) {
            graphPath.push(dep);
            visitDependency(graphPath, newPkg, { isWorkspaceDep: false });
            graphPath.pop();
          }
        }
      }
    }
  };

  visitDependency([graph], rootPkg, { isWorkspaceDep: true });

  return rootPkg;
};

type QueueElement = { graphPath: WorkGraph[]; priorityArray: HoistPriorities[]; depName: PackageName };
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
  graphPath: WorkGraph[],
  depName: PackageName,
  priorityArray: HoistPriorities[],
  currentPriorityDepth: number
): HoistVerdict => {
  const parentPkg = graphPath[graphPath.length - 1];
  const dep = parentPkg.dependencies!.get(depName)!;
  let isHoistable = Hoistable.YES;
  const dependsOn = new Set<PackageName>();
  let priorityDepth;
  let newParentIndex;

  let waterMark;
  for (waterMark = graphPath.length - 1; waterMark > 0; waterMark--) {
    let newParentIdx = waterMark;
    const newParentPkg = graphPath[waterMark];
    if (newParentPkg.wall && (newParentPkg.wall.size === 0 || newParentPkg.wall.has(depName))) break;
    const hoistedParent = newParentPkg?.dependencies?.get(depName)?.newParent;
    if (hoistedParent) {
      newParentIdx = graphPath.indexOf(hoistedParent);
    }

    const newParentDep = newParentPkg.dependencies?.get(depName);
    if (newParentDep && newParentDep.id !== dep.id) {
      waterMark = newParentIdx + 1;
      if (newParentDep.priority) {
        isHoistable = Hoistable.LATER;
        priorityDepth = newParentDep.priority;
      }
      break;
    }
  }

  if (waterMark === graphPath.length - 1) {
    isHoistable = Hoistable.NO;
  }

  if (isHoistable === Hoistable.YES) {
    // Check require contract
    for (newParentIndex = waterMark; newParentIndex < graphPath.length - 1; newParentIndex++) {
      isHoistable = Hoistable.YES;

      const newParentPkg = graphPath[newParentIndex];

      const newParentDep = newParentPkg.dependencies?.get(depName);
      priorityDepth = priorityArray[newParentIndex].get(depName)!.indexOf(dep.id);
      const isDepTurn = priorityDepth <= currentPriorityDepth;
      if (!newParentDep) {
        isHoistable = isDepTurn ? Hoistable.YES : Hoistable.LATER;
      } else {
        isHoistable = newParentDep.id === dep.id ? Hoistable.YES : Hoistable.NO;
      }

      if (isHoistable === Hoistable.YES && dep.dependencies) {
        for (const [hoistedName, hoistedDep] of dep.dependencies) {
          if (hoistedDep.newParent) {
            const originalId = hoistedDep.id;
            const availableId = newParentPkg.dependencies!.get(hoistedName)?.id;

            isHoistable = availableId === originalId ? Hoistable.YES : Hoistable.NO;

            if (isHoistable === Hoistable.NO) break;
          }
        }
      }

      if (isHoistable !== Hoistable.NO) {
        break;
      }
    }
  }

  // Check peer dependency contract
  if (isHoistable === Hoistable.YES) {
    if (dep.peerNames) {
      for (const peerName of dep.peerNames) {
        let peerParent;
        let isHoistedPeerDep;
        let peerParentIdx;
        for (peerParentIdx = graphPath.length - 1; peerParentIdx >= 0; peerParentIdx--) {
          const peerDep = graphPath[peerParentIdx].dependencies?.get(peerName);
          if (peerDep) {
            isHoistedPeerDep = !!peerDep.newParent;
            peerParent = peerDep.newParent || peerDep.originalParent;
            break;
          }
        }

        if (peerParent) {
          if (isHoistedPeerDep) {
            newParentIndex = Math.max(newParentIndex, peerParentIdx);
          } else {
            const depPriority = priorityArray[newParentIndex].get(depName)!.indexOf(dep.id);
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
const getSortedRegularDependencies = (node: WorkGraph, originalDepNames: Set<PackageName>): Set<PackageName> => {
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
  graphPath: WorkGraph[],
  priorityArray: HoistPriorities[],
  currentPriorityDepth: number,
  depNames: Set<PackageName>,
  options: HoistOptions,
  hoistQueue: HoistQueue
) => {
  const parentPkg = graphPath[graphPath.length - 1];

  const sortedDepNames = depNames.size === 1 ? depNames : getSortedRegularDependencies(parentPkg, depNames);
  const peerDependants = new Map<PackageName, Set<PackageName>>();
  const verdictMap = new Map<PackageName, HoistVerdict>();
  for (const depName of sortedDepNames) {
    verdictMap.set(depName, getHoistVerdict(graphPath, depName, priorityArray, currentPriorityDepth));
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
    if (verdict.isHoistable === Hoistable.YES || verdict.isHoistable === Hoistable.DEPENDS) {
      delete dep.priority;
      const rootPkg = graphPath[verdict.newParentIndex];
      for (let idx = verdict.newParentIndex; idx < graphPath.length - 1; idx++) {
        const pkg = graphPath[idx];
        if (!pkg.dependencies!.has(depName)) {
          pkg.dependencies!.set(depName, dep);
        }
        if (!pkg.dependants) {
          pkg.dependants = new Map();
        }
        let depList = pkg.dependants.get(parentPkg);
        if (!depList) {
          depList = new Set();
          pkg.dependants.set(parentPkg, depList);
        }
        depList.add(depName);
      }
      dep.newParent = rootPkg;

      if (options.trace) {
        console.log(
          graphPath.map((x) => x.id),
          'hoist',
          dep.id,
          'into',
          rootPkg.id,
          `result:\n${print(graphPath[0])}`
        );
      }
    } else if (verdict.isHoistable === Hoistable.LATER) {
      if (options.trace) {
        console.log(
          'queue',
          graphPath.map((x) => x.id).concat([dep.id]),
          'to depth:',
          verdict.priorityDepth,
          'cur depth:',
          currentPriorityDepth
        );
      }
      dep.priority = verdict.priorityDepth;

      hoistQueue![verdict.priorityDepth].push({
        graphPath: graphPath.slice(0),
        priorityArray: priorityArray.slice(0),
        depName,
      });
    } else {
      delete dep.priority;
    }
  }
};

type HoistOptions = {
  trace?: boolean;
  check?: CheckType;
};

export const hoist = (pkg: Graph, opts?: HoistOptions): Graph => {
  const graph = toWorkGraph(pkg);
  const options = opts || { trace: false };
  if (options.trace) {
    console.log(`original graph:\n${print(graph)}\n${require('util').inspect(graph, false, null)}`);
  }

  const usages = getUsages(graph, opts);
  const children = getChildren(graph, opts);
  const priorities = getPriorities(usages, children, opts);

  const workspaceIds = new Set<PackageId>();
  const visitWorkspace = (workspace: WorkGraph) => {
    workspaceIds.add(workspace.id);
    if (workspace.workspaces) {
      for (const dep of workspace.workspaces.values()) {
        visitWorkspace(dep);
      }
    }
  };
  visitWorkspace(graph);

  let maxPriorityDepth = 0;
  for (const priorityIds of priorities.values()) {
    maxPriorityDepth = Math.max(maxPriorityDepth, priorityIds.length);
  }
  const hoistQueue: HoistQueue = [];
  for (let idx = 0; idx < maxPriorityDepth; idx++) {
    hoistQueue.push([]);
  }
  let priorityDepth = 0;

  const visitParent = (graphPath: WorkGraph[], priorityArray: HoistPriorities[]) => {
    const node = graphPath[graphPath.length - 1];

    if (node.dependencies) {
      for (const [depName, dep] of node.dependencies) {
        const newDep = decoupleNode(dep);
        newDep.originalParent = node;
        node.dependencies!.set(depName, newDep);
      }
    }

    if (node.workspaces) {
      for (const [workspaceName, workspaceDep] of node.workspaces) {
        const newDep = decoupleNode(workspaceDep);
        newDep.originalParent = node;
        node.workspaces!.set(workspaceName, newDep);
      }
    }

    if (graphPath.length > 1 && node.dependencies) {
      const dependencies = new Set<PackageName>();
      for (const [depName, dep] of node.dependencies) {
        if (!dep.newParent || dep.newParent === node) {
          dependencies.add(depName);
        }
      }

      if (dependencies.size > 0) {
        hoistDependencies(graphPath, priorityArray, priorityDepth, dependencies, options, hoistQueue);
      }
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        for (const depWorkspace of node.workspaces.values()) {
          const depPriorities = getPriorities(usages, getChildren(depWorkspace));
          graphPath.push(depWorkspace);
          priorityArray.push(depPriorities);
          visitParent(graphPath, priorityArray);
          priorityArray.pop();
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          if (dep.id !== node.id && !workspaceIds.has(dep.id) && (!dep.newParent || dep.newParent === node)) {
            const depPriorities = getPriorities(usages, getChildren(dep));
            graphPath.push(dep);
            priorityArray.push(depPriorities);
            visitParent(graphPath, priorityArray);
            priorityArray.pop();
            graphPath.pop();
          }
        }
      }
    }
  };

  visitParent([graph], [priorities]);

  for (priorityDepth = 1; priorityDepth < maxPriorityDepth; priorityDepth++) {
    while (hoistQueue[priorityDepth].length > 0) {
      const queueElement = hoistQueue[priorityDepth].shift()!;
      const graphPath: WorkGraph[] = [];
      const priorityArray: HoistPriorities[] = [];
      let node: WorkGraph | undefined = queueElement.graphPath[queueElement.graphPath.length - 1];
      do {
        graphPath.unshift(node);
        const idx = queueElement.graphPath.indexOf(node);
        priorityArray.unshift(queueElement.priorityArray[idx]);
        node = node.newParent || node.originalParent;
      } while (node);

      hoistDependencies(graphPath, priorityArray, priorityDepth, new Set([queueElement.depName]), options, hoistQueue);
    }
  }

  if (options.trace) {
    console.log(require('util').inspect(graph, false, null));
  }

  return fromWorkGraph(graph);
};

const checkContracts = (graph: WorkGraph): string => {
  const seen = new Set();
  const checkDependency = (graphPath: WorkGraph[]): string => {
    const node = graphPath[graphPath.length - 1];
    const isSeen = seen.has(node);
    seen.add(node);

    let log = '';

    // if (node.hoistedTo) {
    //   for (const [depName, newParent] of node.hoistedTo) {
    //     const dep = newParent.dependencies?.get(depName);
    //     const hoistedIdx = graphPath.indexOf(newParent);
    //     if (!dep) {
    //       log += `${graphPath
    //         .map((x) => x.id)
    //         .join('➣')} unable to find dependency ${depName}, previously hoisted to: ${newParent.id}\n`;
    //     } else if (hoistedIdx < 0) {
    //       log += `${graphPath.map((x) => x.id).join('➣')} unable to find new parent ${
    //         newParent.id
    //       } of previously hoisted dependency ${depName}\n`;
    //     } else {
    //       let foundDep = false;
    //       for (let idx = graphPath.length - 1; idx >= 0; idx--) {
    //         const parentDep = graphPath[idx].dependencies?.get(depName);
    //         if (parentDep && parentDep.id !== newParent.id) {
    //           log += `${graphPath
    //             .map((x) => x.id)
    //             .join('➣')} - broken require contract for ${depName} hoisted to: ${graphPath
    //             .slice(0, hoistedIdx)
    //             .map((x) => x.id)
    //             .join('➣')}`;
    //           log += `: expected ${newParent.id}, but found: ${parentDep.id} at ${graphPath
    //             .slice(0, idx)
    //             .map((x) => x.id)
    //             .join('➣')}`;
    //           if (parentDep.parent !== graphPath[idx]) {
    //             log += `, which is an original dependency`;
    //           } else {
    //             const originalGraph: WorkGraph[] = [];
    //             let parent;
    //             do {
    //               parent = parentDep.parent;
    //               if (parent) {
    //                 originalGraph.unshift(parent);
    //               }
    //             } while (parent);
    //             log += `, which was previously hoisted from ${originalGraph.map((x) => x.id).join('➣')}`;
    //           }
    //           log += `\n`;
    //         }

    //         if (parentDep) {
    //           foundDep = true;
    //           break;
    //         }
    //       }
    //       if (!foundDep) {
    //         log += `${graphPath
    //           .map((x) => x.id)
    //           .join('➣')} - broken require contract for ${depName} hoisted to: ${graphPath
    //           .slice(0, hoistedIdx)
    //           .map((x) => x.id)
    //           .join('➣')}`;
    //         log += `: expected ${newParent.id}, but not found dependency in any of the parents`;
    //       }
    //     }
    //   }
    // }

    // if (node.peerNames) {
    //   const originalGraphPath: WorkGraph[] = [];
    //   let parent;
    //   do {
    //     parent = node.parent;
    //     if (parent) {
    //       originalGraphPath.unshift(parent);
    //     }
    //   } while (parent);

    //   for (const peerName of node.peerNames) {
    //     let peerDep;
    //     for (let idx = originalGraphPath.length - 1; idx >= 0; idx--) {
    //       let peerParent = originalGraphPath[idx].hoistedTo?.get(peerName);
    //       if (!peerParent && originalGraphPath[idx].dependencies?.has(peerName)) {
    //         peerParent = originalGraphPath[idx];
    //       }
    //       if (peerParent) {
    //         const peerDep =
    //       }
    //     }
    //   }
    // }

    if (!isSeen) {
      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          graphPath.push(dep);
          log += checkDependency(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          graphPath.push(dep);
          log += checkDependency(graphPath);
          graphPath.pop();
        }
      }
    }

    return log;
  };

  return checkDependency([graph]);
};

const print = (graph: WorkGraph): string => {
  const printDependency = (
    graphPath: WorkGraph[],
    { prefix, depPrefix, isWorkspace }: { prefix: string; depPrefix: string; isWorkspace: boolean }
  ): string => {
    const node = graphPath[graphPath.length - 1];
    if (graphPath.indexOf(node) !== graphPath.length - 1) return '';

    let str = depPrefix;
    if (isWorkspace) {
      str += 'workspace:';
    } else if (node.packageType === PackageType.PORTAL) {
      str += 'portal:';
    }

    str += node.id;
    if (node.wall) {
      str += '|';
      if (node.wall.size > 0) {
        str += Array.from(node.wall);
      }
    }
    if (node.priority) {
      str += ` queue: ${node.priority}`;
    }
    str += '\n';

    let deps: WorkGraph[] = [];
    let workspaceCount = 0;
    if (node.workspaces) {
      const workspaces = Array.from(node.workspaces.values());
      workspaceCount = workspaces.length;
      deps = deps.concat(workspaces);
    }

    if (node.dependencies) {
      deps = deps.concat(Array.from(node.dependencies.values()).filter((x) => !x.newParent || x.newParent === node));
    }

    for (let idx = 0; idx < deps.length; idx++) {
      const dep = deps[idx];
      graphPath.push(dep);
      const hasMoreDependencies = idx < deps.length - 1;
      str += printDependency(graphPath, {
        depPrefix: prefix + (hasMoreDependencies ? `├─` : `└─`),
        prefix: prefix + (hasMoreDependencies ? `│ ` : `  `),
        isWorkspace: idx < workspaceCount,
      });
      graphPath.pop();
    }

    return str;
  };

  return printDependency([graph], { prefix: '  ', depPrefix: '', isWorkspace: true }).trim();
};
