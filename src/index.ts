import { getPackageName } from './parse';
import { getChildren, getPriorities, getUsages, HoistPriorities } from './priority';

type HoistOptions = {
  trace?: boolean;
  check?: CheckType;
  explain?: boolean;
};

type Route = Array<{ depName: PackageName; isWorkspaceDep: boolean }>;

export type PackageId = string & { _packageId: true };
export type PackageName = string & { _packageName: true };
export enum PackageType {
  PORTAL = 'PORTAL',
}

export enum CheckType {
  THOROUGH = 'THOROUGH',
  FINAL = 'FINAL',
}

export const PackageId = {
  root: '.' as PackageId,
};

export type Graph = {
  id: string;
  tags?: Record<string, string[]>;
  alias?: string;
  dependencies?: Graph[];
  workspaces?: Graph[];
  peerNames?: string[];
  packageType?: PackageType;
  wall?: string[];
  reason?: string;
};

export type WorkGraph = {
  id: PackageId;
  tags?: Map<string, Set<string>>;
  dependencies?: Map<PackageName, WorkGraph>;
  lookupUsages?: Map<WorkGraph, Set<PackageName>>;
  lookupDependants?: Map<PackageName, Set<WorkGraph>>;
  workspaces?: Map<PackageName, WorkGraph>;
  peerNames?: Map<PackageName, Route | null>;
  packageType?: PackageType;
  priority?: number;
  wall?: Set<PackageName>;
  originalParent?: WorkGraph;
  newParent?: WorkGraph;
  reason?: string;
};

const decoupleNode = (node: WorkGraph): WorkGraph => {
  if (node['__decoupled']) return node;

  const clone: WorkGraph = { id: node.id };

  if (node.packageType) {
    clone.packageType = node.packageType;
  }

  if (node.peerNames) {
    clone.peerNames = new Map(node.peerNames);
  }

  if (node.tags) {
    clone.tags = new Map(node.tags);
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

const populateImplicitPeers = (graph: WorkGraph) => {
  const seen = new Set();

  const visitDependency = (graphPath: { node: WorkGraph; isWorkspaceDep: boolean }[]) => {
    const node = graphPath[graphPath.length - 1].node;
    const isSeen = seen.has(node);
    seen.add(node);

    if (node.peerNames && graphPath.length > 1) {
      const parent = graphPath[graphPath.length - 2];
      for (const [peerName, route] of node.peerNames) {
        if (route === null && !parent.node.dependencies?.has(peerName) && !parent.node.peerNames?.has(peerName)) {
          const route: Route = [
            {
              depName: getPackageName(node.id),
              isWorkspaceDep: graphPath[graphPath.length - 1].isWorkspaceDep,
            },
          ];
          for (let idx = graphPath.length - 2; idx >= 0; idx--) {
            const parent = graphPath[idx];
            console.log(route, peerName, parent.node.dependencies);
            if (parent.node.dependencies?.has(peerName)) {
              for (let j = idx + 1; j < graphPath.length - 1; j++) {
                const peerNode = graphPath[j].node;
                if (!peerNode.peerNames) {
                  peerNode.peerNames = new Map();
                }
                if (!peerNode.peerNames.has(peerName)) {
                  peerNode.peerNames.set(peerName, route);
                }
              }
              break;
            } else {
              route.unshift({ depName: getPackageName(parent.node.id), isWorkspaceDep: parent.isWorkspaceDep });
            }
          }
        }
      }
    }

    if (!isSeen) {
      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          graphPath.push({ node: dep, isWorkspaceDep: true });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          graphPath.push({ node: dep, isWorkspaceDep: true });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([{ node: graph, isWorkspaceDep: true }]);
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
      newNode.peerNames = new Map();
      for (const peerName of pkg.peerNames) {
        newNode.peerNames.set(peerName as PackageName, null);
      }
    }

    if (pkg.tags) {
      newNode.tags = new Map();
      for (const [key, tags] of Object.entries(pkg.tags)) {
        newNode.tags.set(key, new Set(tags));
      }
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
      for (const [peerName, route] of node.peerNames) {
        if (route === null) {
          if (!newPkg.peerNames) {
            newPkg.peerNames = [];
          }
          newPkg.peerNames.push(peerName);
        }
      }
    }

    if (node.reason) {
      newPkg.reason = node.reason;
    }

    if (node.tags) {
      newPkg.tags = {};
      const keys = Array.from(node.tags.keys()).sort();
      for (const key of keys) {
        newPkg.tags[key] = Array.from(node.tags.get(key)!).sort();
      }
    }

    if (node.wall) {
      newPkg.wall = Array.from(node.wall).sort();
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
      reason?: string;
    }
  | {
      isHoistable: Hoistable.NO;
      reason: string;
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
  let reason;

  let waterMark = 0;
  for (let idx = graphPath.length - 1; idx >= 0; idx--) {
    const newParentPkg = graphPath[idx];

    const newParentDep = newParentPkg.dependencies?.get(depName);
    if (newParentDep && newParentDep.id !== dep.id) {
      waterMark = idx + 1;
      if (newParentDep.priority && waterMark !== graphPath.length - 1) {
        isHoistable = Hoistable.LATER;
        priorityDepth = newParentDep.priority;
      } else {
        reason = `blocked by a conflicting dependency ${newParentDep.id} at ${printGraphPath(
          graphPath.slice(0, idx + 1)
        )}`;
      }
      break;
    }

    if (newParentPkg.wall && (newParentPkg.wall.size === 0 || newParentPkg.wall.has(depName))) {
      waterMark = idx;
      reason = `blocked by the hoisting wall at ${newParentPkg.id}`;
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
      if (!newParentDep) {
        const isDepTurn = priorityDepth <= currentPriorityDepth;
        isHoistable = isDepTurn ? Hoistable.YES : Hoistable.LATER;
      }

      if (isHoistable === Hoistable.YES && dep.dependencies) {
        for (const [hoistedName, hoistedDep] of dep.dependencies) {
          if (hoistedDep.newParent) {
            const originalId = hoistedDep.id;
            const availableId = newParentPkg.dependencies!.get(hoistedName)?.id;

            isHoistable = availableId === originalId ? Hoistable.YES : Hoistable.NO;

            if (isHoistable === Hoistable.NO) {
              reason = `hoisting to ${printGraphPath(
                graphPath.slice(0, newParentIndex + 1)
              )} will result in usage of ${availableId} instead of ${originalId}`;
              break;
            }
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
      for (const peerName of dep.peerNames.keys()) {
        let peerParent;
        let peerParentIdx;
        let peerDep;
        for (let idx = graphPath.length - 1; idx >= 0; idx--) {
          peerDep = graphPath[idx].dependencies?.get(peerName);
          if (peerDep) {
            peerParent = peerDep.newParent || peerDep.originalParent;
            peerParentIdx = graphPath.indexOf(peerParent);
            break;
          }
        }

        if (peerParent) {
          const depPriority = priorityArray[newParentIndex].get(depName)!.indexOf(dep.id);
          if (depPriority <= currentPriorityDepth) {
            if (peerParentIdx === graphPath.length - 1) {
              // Might be a cyclic peer dependency, mark that we depend on it
              isHoistable = Hoistable.DEPENDS;
              dependsOn.add(peerName);
            } else {
              if (peerParentIdx > newParentIndex) {
                newParentIndex = peerParentIdx;
                reason = `unable to hoist over peer dependency ${printGraphPath(
                  graphPath.slice(0, newParentIndex + 1).concat([peerDep])
                )}`;
              }
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

  if (isHoistable === Hoistable.LATER) {
    return { isHoistable, priorityDepth };
  } else if (isHoistable === Hoistable.DEPENDS) {
    return { isHoistable, dependsOn, newParentIndex };
  } else if (isHoistable === Hoistable.YES) {
    const result: HoistVerdict = { isHoistable, newParentIndex };
    if (reason) {
      result.reason = reason;
    }
    return result;
  } else {
    return { isHoistable, reason };
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
      for (const peerName of dep.peerNames.keys()) {
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
): boolean => {
  let wasGraphChanged = false;
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

  let updatedVerdicts = false;
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
          updatedVerdicts = true;
        } else {
          verdictMap.set(dependantName, verdict);
        }
      }
    }
  }

  if (options.trace) {
    const args = [currentPriorityDepth === 0 ? 'visit' : 'revisit', graphPath.map((x) => x.id), originalVerdictMap];
    if (updatedVerdicts) {
      args.push(`, updated verdicts:`);
      args.push(verdictMap);
    }
    console.log(...args);
  }

  const hoistDependency = (dep: WorkGraph, depName: PackageName, newParentIndex: number) => {
    delete dep.priority;
    const rootPkg = graphPath[newParentIndex];
    for (let idx = newParentIndex; idx < graphPath.length - 1; idx++) {
      const pkg = graphPath[idx];
      const rootPkgDep = pkg.dependencies!.get(depName);
      if (!rootPkgDep) {
        pkg.dependencies!.set(depName, dep);
      }

      if (rootPkgDep && dep.tags) {
        rootPkgDep.tags = rootPkgDep.tags || new Map();
        for (const [key, tags] of dep.tags) {
          let rootDepTags = rootPkgDep.tags.get(key);
          if (!rootDepTags) {
            rootDepTags = new Set<string>();
            rootPkgDep.tags.set(key, rootDepTags);
          }

          for (const tag of tags) {
            rootDepTags.add(tag);
          }
        }
      }

      if (!pkg.lookupUsages) {
        pkg.lookupUsages = new Map();
      }

      let lookupNameList = pkg.lookupUsages.get(parentPkg);
      if (!lookupNameList) {
        lookupNameList = new Set();
        pkg.lookupUsages.set(parentPkg, lookupNameList);
      }
      lookupNameList.add(depName);

      if (!pkg.lookupDependants) {
        pkg.lookupDependants = new Map();
      }

      let dependantList = pkg.lookupDependants.get(depName);
      if (!dependantList) {
        dependantList = new Set();
        pkg.lookupDependants.set(depName, dependantList);
      }
      dependantList.add(parentPkg);
    }
    dep.newParent = rootPkg;

    for (let idx = newParentIndex + 1; idx < graphPath.length; idx++) {
      const pkg = graphPath[idx];
      if (pkg.lookupUsages) {
        const depLookupNames = pkg.lookupUsages.get(dep);
        if (depLookupNames) {
          for (const name of depLookupNames) {
            const dependantList = pkg.lookupDependants!.get(name)!;
            dependantList.delete(dep);
            if (dependantList.size === 0) {
              pkg.lookupDependants!.delete(name);
              const pkgDep = pkg.dependencies!.get(name)!;
              // Delete "lookup" dependency, because of empty set of dependants
              if (pkgDep!.newParent && pkgDep!.newParent !== pkg) {
                if (options.trace) {
                  console.log(
                    `clearing previous lookup dependency by ${dep.id} on ${pkgDep.id} in`,
                    graphPath.slice(0, idx + 1).map((x) => x.id)
                  );
                }
                pkg.dependencies!.delete(name);
              }
            }
          }
        }
        pkg.lookupUsages.delete(dep);
      }
    }

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
  };

  const circularPeerNames = new Set<PackageName>();

  for (const depName of sortedDepNames) {
    const verdict = verdictMap.get(depName)!;
    if (verdict.isHoistable === Hoistable.DEPENDS) {
      circularPeerNames.add(depName);
    }
  }

  if (circularPeerNames.size > 0) {
    for (const depName of circularPeerNames) {
      const dep = parentPkg.dependencies!.get(depName)!;
      const verdict = verdictMap.get(depName)!;
      if (verdict.isHoistable === Hoistable.DEPENDS) {
        if (dep.newParent !== graphPath[verdict.newParentIndex]) {
          hoistDependency(dep, depName, verdict.newParentIndex);
          wasGraphChanged = true;
        }
      }
    }

    if (options.check === CheckType.THOROUGH) {
      const log = checkContracts(graphPath[0]);
      if (log) {
        console.log(
          `Contracts violated after hoisting ${Array.from(circularPeerNames)} from ${printGraphPath(
            graphPath
          )}\n${log}${print(graphPath[0])}`
        );
      }
    }
  }

  for (const depName of sortedDepNames) {
    const dep = parentPkg.dependencies!.get(depName)!;
    const verdict = verdictMap.get(depName)!;
    if (verdict.isHoistable === Hoistable.YES) {
      if (dep.newParent !== graphPath[verdict.newParentIndex]) {
        hoistDependency(dep, depName, verdict.newParentIndex);
        wasGraphChanged = true;

        if (options.check === CheckType.THOROUGH) {
          const log = checkContracts(graphPath[0]);
          if (log) {
            throw new Error(
              `Contracts violated after hoisting ${depName} from ${printGraphPath(graphPath)}\n${log}${print(
                graphPath[0]
              )}`
            );
          }
        }
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
    } else if (verdict.isHoistable === Hoistable.NO) {
      if (options.explain) {
        dep.reason = verdict.reason;
      }
      delete dep.priority;
    } else {
      delete dep.priority;
    }
  }

  return wasGraphChanged;
};

const hoistGraph = (graph: WorkGraph, options: HoistOptions): boolean => {
  let wasGraphChanged = false;

  if (options.trace) {
    console.log(`original graph:\n${print(graph)}`);
  }

  if (options.check) {
    const log = checkContracts(graph);
    if (log) {
      throw new Error(`Contracts violated on initial graph:\n${log}${print(graph)}`);
    }
  }

  const usages = getUsages(graph, options);
  const children = getChildren(graph, options);
  const priorities = getPriorities(usages, children, options);

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
        if (hoistDependencies(graphPath, priorityArray, priorityDepth, dependencies, options, hoistQueue)) {
          wasGraphChanged = true;
        }
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

      if (
        hoistDependencies(graphPath, priorityArray, priorityDepth, new Set([queueElement.depName]), options, hoistQueue)
      ) {
        wasGraphChanged = true;
      }
    }
  }

  if (options.check === CheckType.FINAL) {
    const log = checkContracts(graph);
    if (log) {
      throw new Error(`Contracts violated after hoisting finished:\n${log}${print(graph)}`);
    }
  }

  return wasGraphChanged;
};

const cloneWorkGraph = (graph: WorkGraph): WorkGraph => {
  const clonedNodes = new Map<WorkGraph, WorkGraph>();

  const cloneDependency = (node: WorkGraph) => {
    let clonedNode = clonedNodes.get(node);

    if (!clonedNode) {
      clonedNode = Object.assign({}, node);
      if (node['__decoupled']) {
        Object.defineProperty(clonedNode, '__decoupled', { value: true });
      }

      delete clonedNode.priority;
      clonedNodes.set(node, clonedNode);

      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          cloneDependency(dep);
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          cloneDependency(dep);
        }
      }
    }

    return clonedNode;
  };

  const clonedGraph = cloneDependency(graph);

  for (const node of clonedNodes.values()) {
    if (node.originalParent) {
      node.originalParent = clonedNodes.get(node.originalParent);
    }

    if (node.newParent) {
      node.newParent = clonedNodes.get(node.newParent);
    }

    if (node.dependencies) {
      const newDependencies = new Map();
      for (const [depName, dep] of node.dependencies) {
        newDependencies.set(depName, clonedNodes.get(dep)!);
      }
      node.dependencies = newDependencies;
    }

    if (node.workspaces) {
      const newWorkspaces = new Map();
      for (const [depName, dep] of node.workspaces) {
        newWorkspaces.set(depName, clonedNodes.get(dep)!);
      }
      node.workspaces = newWorkspaces;
    }

    if (node.lookupDependants) {
      const newLookupDependants = new Map();
      for (const [depName, originalUsedBySet] of node.lookupDependants) {
        const usedBySet = new Set<WorkGraph>();
        for (const dep of originalUsedBySet) {
          usedBySet.add(clonedNodes.get(dep)!);
        }
        newLookupDependants.set(depName, usedBySet);
      }
      node.lookupDependants = newLookupDependants;
    }

    if (node.lookupUsages) {
      const newLookupUsages = new Map();
      for (const [dependant, value] of node.lookupUsages) {
        newLookupUsages.set(clonedNodes.get(dependant)!, value);
      }
      node.lookupUsages = newLookupUsages;
    }
  }

  return clonedGraph;
};

export const hoist = (pkg: Graph, opts?: HoistOptions): Graph => {
  const graph = toWorkGraph(pkg);
  const options = opts || { trace: false };

  populateImplicitPeers(graph);
  hoistGraph(graph, options);
  if (options.check) {
    if (options.trace) {
      console.log('second pass');
    }

    const secondGraph = cloneWorkGraph(graph);
    let wasGraphChanged = false;
    try {
      wasGraphChanged = hoistGraph(secondGraph, options);
    } catch (e) {
      throw new Error('While checking for terminal result. ' + (e as any).message);
    }
    if (wasGraphChanged) {
      throw new Error(
        `Hoister produced non-terminal result\nFirst graph:\n${print(graph)}\n\nSecond graph:\n${print(secondGraph)}`
      );
    }
  }

  if (options.trace) {
    console.log(`final hoisted graph:\n${print(graph)}`);
  }

  return fromWorkGraph(graph);
};

const getOriginalGrapPath = (node: WorkGraph): WorkGraph[] => {
  const graphPath: WorkGraph[] = [];

  let pkg: WorkGraph | undefined = node;
  do {
    if (pkg) {
      graphPath.unshift(pkg);
      pkg = pkg.originalParent;
    }
  } while (pkg);

  return graphPath;
};

const getLatestGrapPath = (node: WorkGraph): WorkGraph[] => {
  const graphPath: WorkGraph[] = [];

  let pkg: WorkGraph | undefined = node;
  do {
    if (pkg) {
      graphPath.unshift(pkg);
      pkg = pkg.newParent || pkg.originalParent;
    }
  } while (pkg);

  return graphPath;
};

const printGraphPath = (graphPath: WorkGraph[]): string => graphPath.map((x) => x.id).join('➣');

const checkContracts = (graph: WorkGraph): string => {
  const seen = new Set();
  const checkParent = (graphPath: WorkGraph[]): string => {
    const node = graphPath[graphPath.length - 1];
    const isSeen = seen.has(node);
    seen.add(node);

    let log = '';

    if (node.dependencies) {
      for (const [depName, dep] of node.dependencies) {
        const originalDep = dep.originalParent?.dependencies?.get(depName);
        if (originalDep) {
          let actualDep;
          for (let idx = graphPath.length - 1; idx >= 0; idx--) {
            const nodeDep = graphPath[idx]?.dependencies?.get(depName);
            if (nodeDep && (nodeDep.newParent || nodeDep.originalParent) == graphPath[idx]) {
              actualDep = nodeDep;
              break;
            }
          }

          if (actualDep?.id !== originalDep.id) {
            log += `Expected ${originalDep.id} at ${printGraphPath(graphPath)}, but found: ${actualDep?.id || 'none'}`;
            if (actualDep?.newParent) {
              log += ` previously hoisted from ${printGraphPath(getOriginalGrapPath(actualDep))}`;
            }
            log += `\n`;
          }
        }
      }
    }

    if (node.peerNames) {
      const originalGraphPath = getOriginalGrapPath(node);
      for (const peerName of node.peerNames.keys()) {
        let originalPeerDep;
        for (let idx = originalGraphPath.length - 2; idx >= 0; idx--) {
          const nodeDep = originalGraphPath[idx].dependencies?.get(peerName);
          if (nodeDep?.originalParent == originalGraphPath[idx]) {
            originalPeerDep = nodeDep;
            break;
          }
        }

        if (originalPeerDep) {
          let actualPeerDep;
          for (let idx = graphPath.length - 2; idx >= 0; idx--) {
            const nodeDep = graphPath[idx].dependencies?.get(peerName);
            if (nodeDep && (nodeDep.newParent || nodeDep.originalParent) == graphPath[idx]) {
              actualPeerDep = nodeDep;
              break;
            }
          }

          if (actualPeerDep !== originalPeerDep) {
            log += `Expected peer dependency ${originalPeerDep.id} at ${printGraphPath(graphPath)}, but found: ${
              actualPeerDep?.id || 'none'
            } at ${getLatestGrapPath(actualPeerDep)}`;
            if (actualPeerDep?.newParent) {
              log += ` previously hoisted from ${printGraphPath(getOriginalGrapPath(actualPeerDep))}`;
            }
            log += `\n`;
          }
        }
      }
    }

    if (!isSeen) {
      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          graphPath.push(dep);
          log += checkParent(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          if ((dep.newParent || dep.originalParent) === node) {
            graphPath.push(dep);
            log += checkParent(graphPath);
            graphPath.pop();
          }
        }
      }
    }

    return log;
  };

  return checkParent([graph]);
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
    deps.sort((d1, d2) => (d2.id < d1.id ? 1 : -1));

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
