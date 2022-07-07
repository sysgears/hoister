import { getHoistPriorities } from '../src/priority';
import { Graph, PackageType, toWorkGraph } from '../src';

describe('priority', () => {
  it('should return priorities according to workspace nesting', () => {
    // . -> A -> C@X
    //   -> w1 -> C@1
    //   -> w2 -> C@2
    // should have priorites for C:
    // C@1, C@2, C@X
    const graph: Graph = {
      id: '.',
      dependencies: [{ id: 'A', dependencies: [{ id: 'C@X' }] }],
      workspaces: [
        { id: 'w1', workspaces: [{ id: 'C@1' }] },
        { id: 'w2', workspaces: [{ id: 'C@2' }] },
      ],
    };

    expect(getHoistPriorities(toWorkGraph(graph))).toEqual(
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
    // . -> w1 -> A@X
    //         -> B -> A@Y
    //         -> C -> A@Y
    // should prioritize A@X over A@Y
    const graph: Graph = {
      id: '.',
      workspaces: [
        {
          id: 'w1',
          dependencies: [
            { id: 'A@X' },
            {
              id: 'B',
              dependencies: [{ id: 'A@Y' }],
            },
            {
              id: 'C',
              dependencies: [{ id: 'A@Y' }],
            },
          ],
        },
      ],
    };

    expect(getHoistPriorities(toWorkGraph(graph))).toEqual(
      new Map([
        ['.', ['.']],
        ['w1', ['w1']],
        ['A', ['A@X', 'A@Y']],
        ['B', ['B']],
        ['C', ['C']],
      ])
    );
  });

  it('should take into account peer dependency usages', () => {
    // . -> C -> A@Y -> B --> A
    //   -> D -> A@X
    // A@Y should be prioritized over A@X to hoist B as well to the top
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'C',
          dependencies: [
            {
              id: 'A@Y',
              dependencies: [
                {
                  id: 'B',
                  peerNames: ['A'],
                },
              ],
            },
          ],
        },
        {
          id: 'D',
          dependencies: [{ id: 'A@X' }],
        },
      ],
    };

    expect(getHoistPriorities(toWorkGraph(graph))).toEqual(
      new Map([
        ['.', ['.']],
        ['A', ['A@Y', 'A@X']],
        ['B', ['B']],
        ['C', ['C']],
        ['D', ['D']],
      ])
    );
  });

  it(`should give priority to portal dependencies`, () => {
    // . -> w1 -> p1 -> B@Y
    //         -> A -> B@X
    // B@Y should be prioritized over B@X, because it is a direct dependency of the portal
    const graph: Graph = {
      id: '.',
      workspaces: [
        {
          id: 'w1',
          dependencies: [
            { id: 'p1', dependencies: [{ id: 'B@Y' }], packageType: PackageType.PORTAL },
            { id: 'A', dependencies: [{ id: 'B@X' }] },
          ],
        },
      ],
    };

    expect(getHoistPriorities(toWorkGraph(graph))).toEqual(
      new Map([
        ['.', ['.']],
        ['p1', ['p1']],
        ['w1', ['w1']],
        ['A', ['A']],
        ['B', ['B@Y', 'B@X']],
      ])
    );
  });
});
