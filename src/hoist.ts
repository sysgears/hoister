import { getPackageName } from './parse';
import { getHoistingDecision, finalizeDependedDecisions, Hoistable, HoistingDecision } from './decision';
import { getChildren, getPriorities, getUsages, HoistingPriorities } from './priority';
import { getWorkspaceIds, getAlternativeWorkspaceRoutes, WorkspaceUsageRoutes } from './workspace';

export type HoistingOptions = {
  trace?: boolean;
  check?: CheckType;
  explain?: boolean;
  preserveSymlinksSafe?: boolean;
};

export type GraphRoute = Array<{ name: PackageName; isWorkspaceDep: boolean }>;

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
  priority?: number;
  reason?: string;
};

export type WorkGraph = {
  id: PackageId;
  hoistingPrioriries: HoistingPriorities;
  tags?: Map<string, Set<string>>;
  dependencies?: Map<PackageName, WorkGraph>;
  lookupUsages?: Map<WorkGraph, Set<PackageName>>;
  lookupDependants?: Map<PackageName, Set<WorkGraph>>;
  workspaces?: Map<PackageName, WorkGraph>;
  peerNames?: Map<PackageName, GraphRoute | null>;
  packageType?: PackageType;
  queueIndex?: number;
  wall?: Set<PackageName>;
  originalParent?: WorkGraph;
  newParent?: WorkGraph;
  priority?: number;
  reason?: string;
};

const getGraphPath = (graphRoute: GraphRoute, graph: WorkGraph) => {
  const graphPath = [graph];
  let node = graph;
  for (const nextDep of graphRoute) {
    if (nextDep.isWorkspaceDep) {
      node = node.workspaces!.get(nextDep.name)!;
    } else {
      node = node.dependencies!.get(nextDep.name)!;
    }
    graphPath.push(node);
  }
  return graphPath;
};

const cloneNode = (node: WorkGraph): WorkGraph => {
  const clone: WorkGraph = { id: node.id, hoistingPrioriries: node.hoistingPrioriries };

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

  if (node.priority) {
    clone.priority = node.priority;
  }

  return clone;
};

const getAliasedId = (pkg: Graph): PackageId =>
  !pkg.alias ? (pkg.id as PackageId) : (`${pkg.alias}@>${pkg.id}` as PackageId);

export const fromAliasedId = (aliasedId: PackageId): { alias?: PackageName; id: PackageId } => {
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
          const route: GraphRoute = [
            {
              name: getPackageName(node.id),
              isWorkspaceDep: graphPath[graphPath.length - 1].isWorkspaceDep,
            },
          ];
          for (let idx = graphPath.length - 2; idx >= 0; idx--) {
            const parent = graphPath[idx];
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
              route.unshift({ name: getPackageName(parent.node.id), isWorkspaceDep: parent.isWorkspaceDep });
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
    hoistingPrioriries: new Map(),
  };

  const seen = new Map<Graph, WorkGraph>();

  const visitDependency = (pkg: Graph, parentNode: WorkGraph, { isWorkspaceDep }: { isWorkspaceDep: boolean }) => {
    const aliasedId = getAliasedId(pkg);
    const seenNode = seen.get(pkg);
    const newNode: WorkGraph = pkg === rootPkg ? graph : seenNode || { id: aliasedId, hoistingPrioriries: new Map() };
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

    if (pkg.priority) {
      newNode.priority = pkg.priority;
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

  const seenNodes = new Set();
  const usages = getUsages(graph);
  const fillPriorities = (node: WorkGraph) => {
    if (seenNodes.has(node)) return;
    seenNodes.add(node);

    const children = getChildren(node);
    node.hoistingPrioriries = getPriorities(usages, children);

    if (node.workspaces) {
      for (const dep of node.workspaces.values()) {
        fillPriorities(dep);
      }
    }

    if (node.dependencies) {
      for (const dep of node.dependencies.values()) {
        fillPriorities(dep);
      }
    }
  };

  fillPriorities(graph);

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

    if (node.priority) {
      newPkg.priority = node.priority;
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

type QueueElement = { graphPath: WorkGraph[]; depName: PackageName };
type HoistingQueue = Array<QueueElement[]>;

const hoistDependencies = (
  graphPath: WorkGraph[],
  queueIndex: number,
  depNames: Set<PackageName>,
  options: HoistingOptions,
  hoistingQueue: HoistingQueue,
  lastWorkspaceIndex: number,
  workspaceUsageRoutes: WorkspaceUsageRoutes
): boolean => {
  let wasGraphChanged = false;
  const parentPkg = graphPath[graphPath.length - 1];

  if (options.trace) {
    console.log(
      queueIndex === 0 ? 'visit' : 'revisit',
      graphPath.map((x) => x.id)
    );
  }

  const preliminaryDecisionMap = new Map<PackageName, HoistingDecision>();
  for (const depName of depNames) {
    let decision = getHoistingDecision(graphPath, depName, queueIndex);
    if (
      options.preserveSymlinksSafe &&
      decision.isHoistable !== Hoistable.LATER &&
      decision.newParentIndex < lastWorkspaceIndex
    ) {
      const workspaceId = fromAliasedId(graphPath[lastWorkspaceIndex].id).id;
      const alternativeGraphRoutes = workspaceUsageRoutes.get(workspaceId);
      if (alternativeGraphRoutes) {
        for (const workspaceGraphRoute of alternativeGraphRoutes) {
          const graphPathToWorkspace = getGraphPath(workspaceGraphRoute, graphPath[0]);
          const usageGraphPath = graphPathToWorkspace.concat(graphPath.slice(lastWorkspaceIndex + 1));
          const usageDecision = getHoistingDecision(usageGraphPath, depName, queueIndex);
          if (options.trace) {
            console.log(
              'alternative usage path:',
              usageGraphPath.map((x) => x.id),
              depName,
              'decision:',
              usageDecision
            );
          }
          if (usageDecision.isHoistable === Hoistable.LATER) {
            decision = usageDecision;
            if (options.trace) {
              console.log('updated decision:', decision);
            }
            break;
          } else {
            for (let idx = usageDecision.newParentIndex; idx < usageGraphPath.length; idx++) {
              let originalIndex;
              const node = usageGraphPath[idx];
              for (originalIndex = graphPath.length - 1; originalIndex >= 0; originalIndex--) {
                if (graphPath[originalIndex].id === node.id) {
                  break;
                }
              }
              if (originalIndex >= 0) {
                if (originalIndex > decision.newParentIndex) {
                  decision.newParentIndex = originalIndex;
                  decision.reason = `dependency was not hoisted due to ${usageDecision.reason!} at alternative usage route: ${printGraphPath(
                    usageGraphPath
                  )}`;
                  if (options.trace) {
                    console.log('updated decision:', decision);
                  }
                }
                break;
              }
            }
          }
        }
      }
    }
    preliminaryDecisionMap.set(depName, decision);
  }

  const finalDecisions = finalizeDependedDecisions(preliminaryDecisionMap, options);

  const hoistDependency = (dep: WorkGraph, depName: PackageName, newParentIndex: number) => {
    delete dep.queueIndex;
    const rootPkg = graphPath[newParentIndex];
    for (let idx = newParentIndex; idx < graphPath.length - 1; idx++) {
      const pkg = graphPath[idx];
      const rootPkgDep = pkg.dependencies?.get(depName);
      if (!rootPkgDep) {
        if (!pkg.dependencies) {
          pkg.dependencies = new Map();
        }
        pkg.dependencies.set(depName, dep);
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

  if (finalDecisions.circularPackageNames.size > 0) {
    for (const depName of finalDecisions.circularPackageNames) {
      const dep = parentPkg.dependencies!.get(depName)!;
      const decision = finalDecisions.decisionMap.get(depName)!;
      if (decision.isHoistable === Hoistable.DEPENDS) {
        if (dep.newParent !== graphPath[decision.newParentIndex]) {
          hoistDependency(dep, depName, decision.newParentIndex);
          wasGraphChanged = true;
        }
      }
    }

    if (options.check === CheckType.THOROUGH) {
      const log = checkContracts(graphPath[0]);
      if (log) {
        console.log(
          `Contracts violated after hoisting ${Array.from(finalDecisions.circularPackageNames)} from ${printGraphPath(
            graphPath
          )}\n${log}${print(graphPath[0])}`
        );
      }
    }
  }

  for (const depName of finalDecisions.decisionMap.keys()) {
    const dep = parentPkg.dependencies!.get(depName)!;
    const decision = finalDecisions.decisionMap.get(depName)!;
    if (decision.isHoistable === Hoistable.YES && decision.newParentIndex !== graphPath.length - 1) {
      if (dep.newParent !== graphPath[decision.newParentIndex]) {
        hoistDependency(dep, depName, decision.newParentIndex);
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
    } else if (decision.isHoistable === Hoistable.LATER) {
      if (options.trace) {
        console.log(
          'queue',
          graphPath.map((x) => x.id).concat([dep.id]),
          'to index:',
          decision.queueIndex,
          'current index:',
          queueIndex
        );
      }
      dep.queueIndex = decision.queueIndex;

      hoistingQueue![decision.queueIndex].push({
        graphPath: graphPath.slice(0),
        depName,
      });
    } else {
      if (options.explain && decision.reason) {
        dep.reason = decision.reason;
      }
      delete dep.queueIndex;
    }
  }

  return wasGraphChanged;
};

const hoistGraph = (graph: WorkGraph, options: HoistingOptions): boolean => {
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

  const usages = getUsages(graph);
  const children = getChildren(graph);
  const priorities = getPriorities(usages, children);

  if (options.trace) {
    console.log(`priorities at ${printGraphPath([graph])}: ${require('util').inspect(priorities, false, null)}`);
  }

  let maxQueueIndex = 0;
  for (const priorityIds of priorities.values()) {
    maxQueueIndex = Math.max(maxQueueIndex, priorityIds.length);
  }
  const hoistingQueue: HoistingQueue = [];
  for (let idx = 0; idx < maxQueueIndex; idx++) {
    hoistingQueue.push([]);
  }
  let queueIndex = 0;

  const workspaceIds = getWorkspaceIds(graph);
  let workspaceUsageRoutes: WorkspaceUsageRoutes = new Map();
  if (options.preserveSymlinksSafe) {
    workspaceUsageRoutes = getAlternativeWorkspaceRoutes(graph, workspaceIds);
    if (options.trace && workspaceUsageRoutes.size > 0) {
      console.log('alternative workspace usage routes', require('util').inspect(workspaceUsageRoutes, false, null));
    }
  }

  const visitParent = (graphPath: WorkGraph[], lastWorkspaceIndex: number) => {
    const node = graphPath[graphPath.length - 1];

    if (node.dependencies) {
      for (const [depName, dep] of node.dependencies) {
        if (!dep.originalParent) {
          const newDep = cloneNode(dep);
          newDep.originalParent = node;
          node.dependencies!.set(depName, newDep);
        }
      }
    }

    if (node.workspaces) {
      for (const [workspaceName, workspaceDep] of node.workspaces) {
        if (!workspaceDep.originalParent) {
          const newDep = cloneNode(workspaceDep);
          newDep.originalParent = node;
          node.workspaces!.set(workspaceName, newDep);
        }
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
        if (
          hoistDependencies(
            graphPath,
            queueIndex,
            dependencies,
            options,
            hoistingQueue,
            lastWorkspaceIndex,
            workspaceUsageRoutes
          )
        ) {
          wasGraphChanged = true;
        }
      }
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        for (const depWorkspace of node.workspaces.values()) {
          const depPriorities = getPriorities(usages, getChildren(depWorkspace));
          if (depPriorities.size > 0) {
            graphPath.push(depWorkspace);
            if (options.trace) {
              console.log(
                `priorities at ${printGraphPath(graphPath)}: ${require('util').inspect(depPriorities, false, null)}`
              );
            }
            visitParent(graphPath, lastWorkspaceIndex + 1);
            graphPath.pop();
          }
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          const realDepId = fromAliasedId(dep.id).id;
          if (dep.id !== node.id && !workspaceIds.has(realDepId) && (!dep.newParent || dep.newParent === node)) {
            const depPriorities = dep.hoistingPrioriries;
            if (depPriorities.size > 0) {
              graphPath.push(dep);
              if (options.trace) {
                console.log(
                  `priorities at ${printGraphPath(graphPath)}: ${require('util').inspect(depPriorities, false, null)}`
                );
              }
              visitParent(graphPath, lastWorkspaceIndex);
              graphPath.pop();
            }
          }
        }
      }
    }
  };

  visitParent([graph], 0);

  for (queueIndex = 1; queueIndex < maxQueueIndex; queueIndex++) {
    while (hoistingQueue[queueIndex].length > 0) {
      const queueElement = hoistingQueue[queueIndex].shift()!;
      const graphPath: WorkGraph[] = [];
      let node: WorkGraph | undefined = queueElement.graphPath[queueElement.graphPath.length - 1];
      do {
        graphPath.unshift(node);
        node = node.newParent || node.originalParent;
      } while (node);

      let lastWorkspaceIndex = 0;
      for (let idx = graphPath.length - 1; idx >= 0; idx--) {
        const node = graphPath[idx];
        const realId = fromAliasedId(node.id).id;
        if (workspaceIds.has(realId)) {
          lastWorkspaceIndex = idx;
          break;
        }
      }

      if (
        hoistDependencies(
          graphPath,
          queueIndex,
          new Set([queueElement.depName]),
          options,
          hoistingQueue,
          lastWorkspaceIndex,
          workspaceUsageRoutes
        )
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

      delete clonedNode.queueIndex;
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

export const hoist = (pkg: Graph, opts?: HoistingOptions): Graph => {
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
      const error = new Error('While checking for terminal result. ' + (e as any).message);
      error.stack += (e as any).stack;
      throw error;
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

export const printGraphPath = (graphPath: WorkGraph[]): string => graphPath.map((x) => x.id).join('➣');

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
            } at ${printGraphPath(getLatestGrapPath(actualPeerDep))}`;
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
    if (node.queueIndex) {
      str += ` queue: ${node.queueIndex}`;
    }
    if (node.reason) {
      str += ` - ${node.reason}`;
    }
    str += '\n';

    const deps: { node: WorkGraph; isWorkspaceDep: boolean }[] = [];
    if (node.workspaces) {
      for (const dep of node.workspaces.values()) {
        deps.push({ node: dep, isWorkspaceDep: true });
      }
    }

    if (node.dependencies) {
      for (const dep of node.dependencies.values()) {
        if (!dep.newParent || dep.newParent === node) {
          deps.push({ node: dep, isWorkspaceDep: false });
        }
      }
    }
    deps.sort((d1, d2) => (d2.node.id < d1.node.id ? 1 : -1));

    for (let idx = 0; idx < deps.length; idx++) {
      const dep = deps[idx];
      graphPath.push(dep.node);
      const hasMoreDependencies = idx < deps.length - 1;
      str += printDependency(graphPath, {
        depPrefix: prefix + (hasMoreDependencies ? `├─` : `└─`),
        prefix: prefix + (hasMoreDependencies ? `│ ` : `  `),
        isWorkspace: dep.isWorkspaceDep,
      });
      graphPath.pop();
    }

    return str;
  };

  return printDependency([graph], { prefix: '  ', depPrefix: '', isWorkspace: true }).trim();
};
