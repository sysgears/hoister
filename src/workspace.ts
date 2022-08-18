import { PackageId, WorkGraph, fromAliasedId } from './hoist';

export type WorkspaceUsages = Map<PackageId, Set<WorkGraph[]>>;

export const getWorkspaceIds = (graph: WorkGraph): Set<PackageId> => {
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

  return workspaceIds;
};

export const getPackageUsagePaths = (graph: WorkGraph, packageIds: Set<PackageId>): WorkspaceUsages => {
  const usages = new Map();
  const seen = new Set();

  const visitDependency = (graphPath: WorkGraph[]) => {
    const node = graphPath[graphPath.length - 1];
    const isSeen = seen.has(node);
    seen.add(node);

    const realId = fromAliasedId(node.id).id;
    if (packageIds.has(realId)) {
      let usagePaths = usages.get(realId);
      if (!usagePaths) {
        usagePaths = new Set();
        usages.set(realId, usagePaths);
      }
      usagePaths.add(graphPath);
    }

    if (!isSeen) {
      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          graphPath.push(dep);
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          graphPath.push(dep);
          visitDependency(graphPath);
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([graph]);

  return usages;
};
