import { getHoistPriorities } from '../src/priority';
import { Package, toGraph } from '../src';

describe('priority', () => {
  it('should return priorities according to workspace nesting', () => {
    // . -> A -> C@X
    //   -> w1 -> C@1
    //   -> w2 -> C@2
    // should have priorites for C:
    // C@1, C@2, C@X
    const pkg = {
      id: '.',
      dependencies: [{ id: 'A', dependencies: [{ id: 'C@X' }] }],
      workspaces: [
        { id: 'w1', workspaces: [{ id: 'C@1' }] },
        { id: 'w2', workspaces: [{ id: 'C@2' }] },
      ],
    };

    expect(getHoistPriorities(toGraph(pkg as Package), { trace: true })).toEqual(
      new Map([
        ['.', ['.']],
        ['A', ['A']],
        ['w1', ['w1']],
        ['w2', ['w2']],
        ['C', ['C@1', 'C@2', 'C@X']],
      ])
    );
  });

  it('should prioritize direct workspace dependencies over indirect', () => {
    const pkg = {
      id: '.',
      workspaces: [
        {
          id: 'WA',
          dependencies: [
            { id: 'D@1' },
            {
              id: 'C',
              dependencies: [
                {
                  id: 'D@2',
                  peerNames: ['PA'],
                },
              ],
            },
            { id: 'PA' },
          ],
        },
      ],
    };

    expect(getHoistPriorities(toGraph(pkg as Package))).toEqual(
      new Map([
        ['.', ['.']],
        ['WA', ['WA']],
        ['C', ['C']],
        ['D', ['D@1', 'D@2']],
        ['PA', ['PA']],
      ])
    );
  });

  it('should prioritize dependencies with more peer dependencies', () => {
    const pkg = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'C@1', peerNames: ['PA'] }, { id: 'PA' }] },
        { id: 'B', dependencies: [{ id: 'C@2', peerNames: ['PA', 'PB'] }, { id: 'PA' }, { id: 'PB' }] },
      ],
    };

    expect(getHoistPriorities(toGraph(pkg as Package))).toEqual(
      new Map([
        ['.', ['.']],
        ['B', ['B']],
        ['A', ['A']],
        ['C', ['C@2', 'C@1']],
        ['PA', ['PA']],
        ['PB', ['PB']],
      ])
    );
  });

  it('should prioritize direct portal dependencies over indirect dependencies', () => {
    const pkg = {
      id: '.',
      dependencies: [
        {
          id: 'P',
          dependencies: [
            {
              id: 'A',
              dependencies: [{ id: 'B@2' }],
            },
            { id: 'B@1' },
          ],
        },
      ],
    };

    expect(getHoistPriorities(toGraph(pkg as Package))).toEqual(
      new Map([
        ['.', ['.']],
        ['A', ['A']],
        ['B', ['B@1', 'B@2']],
        ['P', ['P']],
      ])
    );
  });
});
