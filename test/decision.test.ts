import { PackageName } from '../src/hoist';
import { DecisionMap, finalizeDependedDecisions, Hoistable } from '../src/decision';

describe('hoist', () => {
  it('should finalize decisions that depend on the package hoisted lower than dependants', () => {
    const decisionMap: DecisionMap = new Map([
      [
        'A' as PackageName,
        {
          isHoistable: Hoistable.DEPENDS,
          dependsOn: new Set(['B' as PackageName]),
          newParentIndex: 0,
        },
      ],
      [
        'B' as PackageName,
        {
          isHoistable: Hoistable.DEPENDS,
          dependsOn: new Set(['A' as PackageName, 'C' as PackageName]),
          newParentIndex: 0,
        },
      ],
      [
        'C' as PackageName,
        {
          isHoistable: Hoistable.YES,
          newParentIndex: 2,
          reason: 'C@X is blocked by C@Y',
        },
      ],
    ]);

    const finalDecisions = finalizeDependedDecisions(decisionMap);
    expect(finalDecisions).toEqual({
      decisionMap: new Map([
        [
          'A' as PackageName,
          {
            isHoistable: Hoistable.YES,
            newParentIndex: 2,
            reason: 'peer dependency was not hoisted, due to C@X is blocked by C@Y',
          },
        ],
        [
          'B' as PackageName,
          {
            isHoistable: Hoistable.YES,
            newParentIndex: 2,
            reason: 'peer dependency was not hoisted, due to C@X is blocked by C@Y',
          },
        ],
        [
          'C' as PackageName,
          {
            isHoistable: Hoistable.YES,
            newParentIndex: 2,
            reason: 'C@X is blocked by C@Y',
          },
        ],
      ]),
      circularPackageNames: new Set(),
    });
  });

  it('should finalize decisions that depend on the package hoisted higher than dependants', () => {
    const decisionMap: DecisionMap = new Map([
      [
        'A' as PackageName,
        {
          isHoistable: Hoistable.DEPENDS,
          dependsOn: new Set(['B' as PackageName]),
          newParentIndex: 2,
          reason: 'A@X is blocked by A@Y',
        },
      ],
      [
        'B' as PackageName,
        {
          isHoistable: Hoistable.YES,
          newParentIndex: 1,
          reason: 'B@X is blocked by B@Y',
        },
      ],
    ]);

    const finalDecisions = finalizeDependedDecisions(decisionMap);
    expect(finalDecisions).toEqual({
      decisionMap: new Map([
        [
          'A' as PackageName,
          {
            isHoistable: Hoistable.YES,
            newParentIndex: 2,
            reason: 'A@X is blocked by A@Y',
          },
        ],
        [
          'B' as PackageName,
          {
            isHoistable: Hoistable.YES,
            newParentIndex: 1,
            reason: 'B@X is blocked by B@Y',
          },
        ],
      ]),
      circularPackageNames: new Set(),
    });
  });

  it('should finalize decisions that circular depend on each another', () => {
    const decisionMap: DecisionMap = new Map([
      [
        'A' as PackageName,
        {
          isHoistable: Hoistable.DEPENDS,
          dependsOn: new Set(['B' as PackageName]),
          newParentIndex: 2,
          reason: 'A@X is blocked by A@Y',
        },
      ],
      [
        'B' as PackageName,
        {
          isHoistable: Hoistable.DEPENDS,
          dependsOn: new Set(['A' as PackageName]),
          newParentIndex: 1,
          reason: 'B@X is blocked by B@Y',
        },
      ],
    ]);

    const finalDecisions = finalizeDependedDecisions(decisionMap);
    expect(finalDecisions).toEqual({
      decisionMap: new Map([
        [
          'A' as PackageName,
          {
            isHoistable: Hoistable.DEPENDS,
            dependsOn: new Set(['B' as PackageName]),
            newParentIndex: 2,
            reason: 'A@X is blocked by A@Y',
          },
        ],
        [
          'B' as PackageName,
          {
            isHoistable: Hoistable.DEPENDS,
            dependsOn: new Set(['A' as PackageName]),
            newParentIndex: 2,
            reason: 'peer dependency was not hoisted, due to A@X is blocked by A@Y',
          },
        ],
      ]),
      circularPackageNames: new Set(['A', 'B']),
    });
  });

  it('should finalize decisions when dependees need to be hoisted later', () => {
    const decisionMap: DecisionMap = new Map([
      [
        'A' as PackageName,
        {
          isHoistable: Hoistable.DEPENDS,
          dependsOn: new Set(['B' as PackageName, 'C' as PackageName]),
          newParentIndex: 2,
          reason: 'A@X is blocked by A@Y',
        },
      ],
      [
        'B' as PackageName,
        {
          isHoistable: Hoistable.LATER,
          queueIndex: 1,
        },
      ],
      [
        'C' as PackageName,
        {
          isHoistable: Hoistable.LATER,
          queueIndex: 3,
        },
      ],
    ]);

    const finalDecisions = finalizeDependedDecisions(decisionMap);
    expect(finalDecisions).toEqual({
      decisionMap: new Map([
        [
          'A' as PackageName,
          {
            isHoistable: Hoistable.LATER,
            queueIndex: 3,
          },
        ],
        [
          'B' as PackageName,
          {
            isHoistable: Hoistable.LATER,
            queueIndex: 1,
          },
        ],
        [
          'C' as PackageName,
          {
            isHoistable: Hoistable.LATER,
            queueIndex: 3,
          },
        ],
      ]),
      circularPackageNames: new Set(),
    });
  });
});
