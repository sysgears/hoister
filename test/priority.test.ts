import { getHoistPriorities } from '../src/priority';
import { Graph, toWorkGraph } from '../src';

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
});
