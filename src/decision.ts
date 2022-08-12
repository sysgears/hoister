import { PackageName, WorkGraph, printGraphPath } from './hoist';
import { HoistingPriorities } from './priority';

export enum Hoistable {
  LATER = 'LATER',
  YES = 'YES',
  DEPENDS = 'DEPENDS',
}

export type HoistingDecision =
  | {
      isHoistable: Hoistable.LATER;
      queueIndex: number;
    }
  | {
      isHoistable: Hoistable.YES;
      newParentIndex: number;
      reason?: string;
    }
  | {
      isHoistable: Hoistable.DEPENDS;
      dependsOn: Set<PackageName>;
      newParentIndex: number;
      reason?: string;
    };

export type FinalDecisions = {
  decisionMap: Map<PackageName, HoistingDecision>;
  circularPackageNames: Set<PackageName>;
};

export type DecisionMap = Map<PackageName, HoistingDecision>;

type DecisionOptions = {
  trace?: boolean;
};

export const getHoistingDecision = (
  graphPath: WorkGraph[],
  depName: PackageName,
  priorityArray: HoistingPriorities[],
  currentPriorityDepth: number
): HoistingDecision => {
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
      if (newParentDep.queueIndex && waterMark !== graphPath.length - 1) {
        isHoistable = Hoistable.LATER;
        priorityDepth = newParentDep.queueIndex;
      } else {
        reason = `${dep.id} is blocked by a conflicting dependency ${newParentDep.id} at ${printGraphPath(
          graphPath.slice(0, idx + 1)
        )}`;
      }
      break;
    }

    if (newParentPkg.wall && (newParentPkg.wall.size === 0 || newParentPkg.wall.has(depName))) {
      waterMark = idx;
      reason = `${dep.id} is blocked by the hoisting wall at ${newParentPkg.id}`;
      break;
    }
  }

  if (isHoistable === Hoistable.YES) {
    // Check require contract
    for (newParentIndex = waterMark; newParentIndex < graphPath.length - 1; newParentIndex++) {
      const newParentPkg = graphPath[newParentIndex];

      const newParentDep = newParentPkg.dependencies?.get(depName);
      priorityDepth = priorityArray[newParentIndex].get(depName)!.indexOf(dep.id);
      if (!newParentDep) {
        const isDepTurn = priorityDepth <= currentPriorityDepth;
        if (!isDepTurn) {
          isHoistable = Hoistable.LATER;
          break;
        }
      }

      let canBeHoisted = true;
      if (dep.dependencies) {
        for (const [hoistedName, hoistedDep] of dep.dependencies) {
          if (hoistedDep.newParent) {
            const originalId = hoistedDep.id;
            const availableId = newParentPkg.dependencies!.get(hoistedName)?.id;

            if (availableId !== originalId) {
              canBeHoisted = false;
              reason = `hoisting ${dep.id} to ${printGraphPath(
                graphPath.slice(0, newParentIndex + 1)
              )} will result in usage of ${availableId || "'none'"} instead of ${originalId}`;
              break;
            }
          }
        }
      }

      if (canBeHoisted) {
        break;
      }
    }
  }

  // Check peer dependency contract
  if (isHoistable === Hoistable.YES) {
    if (dep.peerNames) {
      for (const peerName of dep.peerNames.keys()) {
        if (peerName !== depName) {
          let peerParent;
          let peerParentIdx;
          for (let idx = graphPath.length - 1; idx >= 0; idx--) {
            if (!graphPath[idx].peerNames?.has(peerName)) {
              peerParentIdx = idx;
              peerParent = graphPath[idx];
              break;
            }
          }

          const peerDep = peerParent.dependencies?.get(peerName);

          if (peerDep) {
            const depPriority = priorityArray[newParentIndex].get(depName)!.indexOf(dep.id);
            if (depPriority <= currentPriorityDepth) {
              if (peerParentIdx === graphPath.length - 1) {
                // Might be a cyclic peer dependency, mark that we depend on it
                isHoistable = Hoistable.DEPENDS;
                dependsOn.add(peerName);
              } else {
                if (peerParentIdx > newParentIndex) {
                  newParentIndex = peerParentIdx;
                  reason = `unable to hoist ${dep.id} over peer dependency ${printGraphPath(
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
  }

  if (isHoistable === Hoistable.LATER) {
    return { isHoistable, queueIndex: priorityDepth };
  } else if (isHoistable === Hoistable.DEPENDS) {
    const result: HoistingDecision = { isHoistable, dependsOn, newParentIndex };
    if (reason) {
      result.reason = reason;
    }
    return result;
  } else {
    const result: HoistingDecision = { isHoistable: Hoistable.YES, newParentIndex };
    if (reason) {
      result.reason = reason;
    }
    return result;
  }
};

export const finalizeDependedDecisions = (
  preliminaryDecisionMap: DecisionMap,
  opts?: DecisionOptions
): FinalDecisions => {
  const options = opts || { trace: false };

  if (options.trace) {
    console.log('decisions:', require('util').inspect(preliminaryDecisionMap, false, null));
  }

  const finalDecisions: FinalDecisions = {
    decisionMap: new Map(),
    circularPackageNames: new Set(),
  };

  const dependsOn = new Map<PackageName, Set<PackageName>>();
  const getRecursiveDependees = (dependant: PackageName, seen: Set<PackageName>): Set<PackageName> => {
    const dependees = new Set<PackageName>();
    if (seen.has(dependant)) return dependees;
    seen.add(dependant);

    const decision = preliminaryDecisionMap.get(dependant);
    if (decision && decision.isHoistable === Hoistable.DEPENDS) {
      for (const dependee of decision.dependsOn) {
        dependees.add(dependee);

        const nestedDependees = getRecursiveDependees(dependee, seen);
        for (const nestedDependee of nestedDependees) {
          dependees.add(nestedDependee);
        }
      }
    }

    dependees.delete(dependant);
    return dependees;
  };

  for (const [dependantName, decision] of preliminaryDecisionMap) {
    if (decision.isHoistable === Hoistable.DEPENDS) {
      const dependees = getRecursiveDependees(dependantName, new Set());
      dependsOn.set(dependantName, dependees);

      const dependeesArray = Array.from(dependees);
      for (let idx = dependeesArray.length - 1; idx >= 0; idx--) {
        const dependee = dependeesArray[idx];
        const dependeeDecision = preliminaryDecisionMap.get(dependee);
        if (dependeeDecision && !finalDecisions.decisionMap.has(dependee)) {
          finalDecisions.decisionMap.set(dependee, dependeeDecision);
        }
      }
    } else {
      finalDecisions.decisionMap.set(dependantName, decision);
    }
  }

  if (options.trace && dependsOn.size > 0) {
    console.log('dependsOn:', dependsOn);
  }

  for (const [dependantName, dependees] of dependsOn) {
    const originalDecision = preliminaryDecisionMap.get(dependantName)!;
    if (originalDecision.isHoistable === Hoistable.DEPENDS) {
      let isHoistable: Hoistable = originalDecision.isHoistable;
      let priorityDepth = 0;
      let newParentIndex: number = originalDecision.newParentIndex;
      let reason: string | undefined = originalDecision.reason;
      for (const dependeeName of dependees) {
        const dependeeDecision = preliminaryDecisionMap.get(dependeeName);
        if (dependeeDecision) {
          if (dependeeDecision.isHoistable === Hoistable.LATER) {
            isHoistable = Hoistable.LATER;
            priorityDepth = Math.max(priorityDepth, dependeeDecision.queueIndex);
          } else if (isHoistable !== Hoistable.LATER) {
            if (dependeeDecision.isHoistable === Hoistable.YES) {
              isHoistable = Hoistable.YES;
            }
            if (dependeeDecision.newParentIndex > newParentIndex) {
              newParentIndex = dependeeDecision.newParentIndex;
              reason = `peer dependency was not hoisted, due to ${dependeeDecision.reason}`;
            }
          }
        }
      }

      if (isHoistable !== Hoistable.DEPENDS || newParentIndex > originalDecision.newParentIndex) {
        let finalDecision: HoistingDecision;
        if (isHoistable === Hoistable.LATER) {
          finalDecision = { isHoistable, queueIndex: priorityDepth };
        } else if (isHoistable === Hoistable.YES) {
          finalDecision = { isHoistable, newParentIndex };
          if (reason) {
            finalDecision.reason = reason;
          }
        } else {
          finalDecision = { isHoistable, newParentIndex, dependsOn: originalDecision.dependsOn };
          if (reason) {
            finalDecision.reason = reason;
          }
        }
        finalDecisions.decisionMap.set(dependantName, finalDecision);
      }
    }
  }

  for (const depName of finalDecisions.decisionMap.keys()) {
    const decision = finalDecisions.decisionMap.get(depName)!;
    if (decision.isHoistable === Hoistable.DEPENDS) {
      finalDecisions.circularPackageNames.add(depName);
    }
  }

  if (options.trace && dependsOn.size > 0) {
    console.log('final decisions:', require('util').inspect(finalDecisions, false, null));
  }

  return finalDecisions;
};
