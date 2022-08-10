import { PackageName } from '../src/hoist';
import { DecisionMap, finalizeDependedDecisions, Hoistable } from '../src/decision';

describe('hoist', () => {
  it('should finalize decisions that depend on unhoistable package', () => {
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
});
