import { PackageId, WorkGraph, fromAliasedId, GraphRoute } from './hoist';

export type WorkspaceUsageRoutes = Map<PackageId, Set<GraphRoute>>;

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

export const getAlternativeWorkspaceRoutes = (graph: WorkGraph, packageIds: Set<PackageId>): WorkspaceUsageRoutes => {
  const usages = new Map();
  const seen = new Set();

  const visitDependency = (graphRoute: GraphRoute, node: WorkGraph) => {
    const isSeen = seen.has(node);
    seen.add(node);

    const realId = fromAliasedId(node.id).id;
    if (packageIds.has(realId) && graphRoute.length > 0 && !graphRoute[graphRoute.length - 1].isWorkspaceDep) {
      let workspaceRoutes = usages.get(realId);
      if (!workspaceRoutes) {
        workspaceRoutes = new Set();
        usages.set(realId, workspaceRoutes);
      }
      workspaceRoutes.add(graphRoute.slice(0));
    }

    if (!isSeen) {
      if (node.workspaces) {
        for (const [name, dep] of node.workspaces) {
          graphRoute.push({ isWorkspaceDep: true, name });
          visitDependency(graphRoute, dep);
          graphRoute.pop();
        }
      }

      if (node.dependencies) {
        for (const [name, dep] of node.dependencies) {
          graphRoute.push({ isWorkspaceDep: false, name });
          visitDependency(graphRoute, dep);
          graphRoute.pop();
        }
      }
    }
  };

  visitDependency([], graph);

  return usages;
};
