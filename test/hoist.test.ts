import { Graph, hoist, PackageType } from '../src';

describe('hoist', () => {
  it('should do very basic hoisting', () => {
    // . -> A -> B
    // should be hoisted to:
    // . -> A
    //   -> B
    const graph: Graph = {
      id: '.',
      dependencies: [{ id: 'A', dependencies: [{ id: 'B' }] }],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [{ id: 'A' }, { id: 'B' }],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should not hoist conflicting versions of a package`, () => {
    // . -> A -> C@X -> D@X
    //               -> E
    //   -> C@Y
    //   -> D@Y
    // should be hoisted to:
    // . -> A
    //        -> C@X
    //        -> D@X
    //   -> C@Y
    //   -> D@Y
    //   -> E
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [{ id: 'C@X', dependencies: [{ id: 'D@X' }, { id: 'E' }] }],
        },
        { id: 'C@Y' },
        { id: 'D@Y' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [{ id: 'C@X' }, { id: 'D@X' }],
        },
        { id: 'C@Y' },
        { id: 'D@Y' },
        { id: 'E' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should support basic cyclic dependencies`, () => {
    // . -> C -> A -> B -> A
    //             -> D -> E
    // should be hoisted to:
    // . -> A
    //   -> B
    //   -> C
    //   -> D
    //   -> E
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'C',
          dependencies: [
            {
              id: 'A',
              dependencies: [
                { id: 'B', dependencies: [{ id: 'A' }] },
                { id: 'D', dependencies: [{ id: 'E' }] },
              ],
            },
          ],
        },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should hoist different instances of the package independently', () => {
    // . -> A -> B@X -> C@X
    //        -> C@Y
    //   -> D -> B@X -> C@X
    //   -> B@Y
    //   -> C@Z
    // should be hoisted to (top C@X instance must not be hoisted):
    // . -> A -> B@X -> C@X
    //        -> C@Y
    //   -> D -> B@X
    //        -> C@X
    //   -> B@Y
    //   -> C@Z
    const BX: Graph = { id: 'B@X', dependencies: [{ id: 'C@X' }] };
    const graph: Graph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [BX, { id: 'C@Y' }] },
        { id: 'D', dependencies: [BX] },
        { id: 'B@Y' },
        { id: 'C@Z' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'B@X', dependencies: [{ id: 'C@X' }] }, { id: 'C@Y' }] },
        { id: 'B@Y' },
        { id: 'C@Z' },
        { id: 'D', dependencies: [{ id: 'B@X' }, { id: 'C@X' }] },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should honor package popularity when hoisting`, () => {
    // . -> A -> B@X -> E@X
    //   -> B@Y
    //   -> C -> E@Y
    //   -> D -> E@Y
    // should be hoisted to:
    // . -> A -> B@X
    //        -> E@X
    //   -> B@Y
    //   -> C
    //   -> D
    //   -> E@Y
    const graph: Graph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'B@X', dependencies: [{ id: 'E@X' }] }] },
        { id: 'B@Y' },
        { id: 'C', dependencies: [{ id: 'E@Y' }] },
        { id: 'D', dependencies: [{ id: 'E@Y' }] },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'B@X' }, { id: 'E@X' }] },
        { id: 'B@Y' },
        { id: 'C' },
        { id: 'D' },
        { id: 'E@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should handle graph path cuts because of popularity', () => {
    //                  1       1      2
    // . -> A -> H@X -> B@X -> I@X -> B@Z
    //               -> I@Y
    //   -> C -> B@Y
    //   -> D -> B@Y
    //   -> E -> B@Y
    //   -> F -> B@X
    //   -> H@Y
    //   -> I@Y
    // should be hoisted to:
    // . -> A -> B@X
    //        -> H@X
    //        -> I@X -> B@Z
    //   -> B@Y
    //   -> C
    //   -> D
    //   -> E
    //   -> F -> B@X
    //   -> H@Y
    //   -> I@Y
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'H@X',
              dependencies: [
                { id: 'B@X', dependencies: [{ id: 'I@X', dependencies: [{ id: 'B@Z' }] }] },
                { id: 'I@Y' },
              ],
            },
          ],
        },
        { id: 'C', dependencies: [{ id: 'B@Y' }] },
        { id: 'D', dependencies: [{ id: 'B@Y' }] },
        { id: 'E', dependencies: [{ id: 'B@Y' }] },
        { id: 'F', dependencies: [{ id: 'B@X' }] },
        { id: 'H@Y' },
        { id: 'I@Y' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            { id: 'B@X' },
            { id: 'H@X' },
            {
              id: 'I@X',
              dependencies: [{ id: 'B@Z' }],
            },
          ],
        },
        { id: 'B@Y' },
        { id: 'C' },
        { id: 'D' },
        { id: 'E' },
        {
          id: 'F',
          dependencies: [
            {
              id: 'B@X',
            },
          ],
        },
        { id: 'H@Y' },
        { id: 'I@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should handle conflict with original dependencies after dependencies hoisting`, () => {
    // . -> A -> B@X -> C@X -> D@X
    //        -> D@Y
    //   -> B@Y
    //   -> E -> C@Y
    //        -> D@Y
    //   -> F -> C@Y
    // should be hoisted to:
    // . -> A -> B@X -> C@X
    //               -> D@X
    //        -> D@Y
    //   -> B@Y
    //   -> C@Y
    //   -> D@X
    //   -> E
    //   -> F
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B@X',
              dependencies: [
                {
                  id: 'C@X',
                  dependencies: [
                    {
                      id: 'D@X',
                    },
                  ],
                },
              ],
            },
            { id: 'D@Y' },
          ],
        },
        { id: 'B@Y' },
        { id: 'E', dependencies: [{ id: 'C@Y' }, { id: 'D@Y' }] },
        { id: 'F', dependencies: [{ id: 'C@Y' }] },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B@X',
              dependencies: [{ id: 'C@X' }, { id: 'D@X' }],
            },
          ],
        },
        { id: 'B@Y' },
        { id: 'C@Y' },
        { id: 'D@Y' },
        { id: 'E' },
        { id: 'F' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should not hoisted to a place of previously hoisted dependency with conflicting version', () => {
    // . -> A -> B@X
    //        -> C@X -> B@Y
    //   -> C@Y
    // should be hoisted to:
    // . -> A -> C@X -> B@Y
    //   -> B@X
    //   -> C@Y
    // B@Y cannot be hoisted further to A because it will take place of B@X in A, which result in a conflict
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B@X',
            },
            {
              id: 'C@X',
              dependencies: [{ id: 'B@Y' }],
            },
          ],
        },
        { id: 'C@Y' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'C@X',
              dependencies: [{ id: 'B@Y' }],
            },
          ],
        },
        { id: 'B@X' },
        { id: 'C@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should not break require promise by hoisting higher than the package with conflicting version', () => {
    // . -> A -> B@Y
    //        -> C@X -> B@X
    //   -> C@Y -> B@Y
    // should be hoisted to:
    // . -> A -> C@X -> B@X
    //   -> B@Y
    //   -> C@Y
    // The B@X cannot be hoisted to the top, because in this case the C@X will get B@Y instead of B@X when requiring B.
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            { id: 'B@Y' },
            {
              id: 'C@X',
              dependencies: [{ id: 'B@X' }],
            },
          ],
        },
        { id: 'C@Y', dependencies: [{ id: 'B@Y' }] },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'C@X',
              dependencies: [{ id: 'B@X' }],
            },
          ],
        },
        { id: 'B@Y' },
        { id: 'C@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should properly hoist package that has several versions on the tree path`, () => {
    // . -> A -> B@X -> C@Y -> E@X
    //               -> D@Y -> E@Y -> C@X
    //   -> B@Y
    //   -> C@X
    //   -> D@X
    //   -> E@X
    // should be hoisted to:
    // . -> A -> B@X -> C@Y
    //        -> D@Y -> E@Y
    //   -> B@Y
    //   -> C@X
    //   -> D@X
    //   -> E@X
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B@X',
              dependencies: [
                {
                  id: 'C@Y',
                  dependencies: [{ id: 'E@X' }],
                },
                {
                  id: 'D@Y',
                  dependencies: [
                    {
                      id: 'E@Y',
                      dependencies: [{ id: 'C@X' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { id: 'B@Y' },
        { id: 'C@X' },
        { id: 'D@X' },
        { id: 'E@X' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B@X',
              dependencies: [{ id: 'C@Y' }],
            },
            { id: 'D@Y', dependencies: [{ id: 'E@Y' }] },
          ],
        },
        { id: 'B@Y' },
        { id: 'C@X' },
        { id: 'D@X' },
        { id: 'E@X' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should tolerate self-dependencies`, () => {
    // . -> .
    //   -> A -> A
    //        -> B@X -> B@X
    //               -> C@Y
    //        -> C@X
    //   -> B@Y
    //   -> C@X
    // should be hoisted to:
    // . -> A -> B@X -> C@Y
    //   -> B@Y
    //   -> C@X
    const graph: Graph = {
      id: '.',
      dependencies: [
        { id: '.' },
        {
          id: 'A',
          dependencies: [
            { id: 'A' },
            {
              id: 'B@X',
              dependencies: [{ id: 'B@X' }, { id: 'C@Y' }],
            },
            { id: 'C@X' },
          ],
        },
        { id: 'B@Y' },
        { id: 'C@X' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        { id: '.' },
        {
          id: 'A',
          dependencies: [{ id: 'B@X', dependencies: [{ id: 'C@Y' }] }],
        },
        { id: 'B@Y' },
        { id: 'C@X' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should support basic peer dependencies`, () => {
    // . -> A -> B --> D
    //        -> D@X
    //   -> D@Y
    // should be hoisted to (A and B should share single D@X dependency):
    // . -> A -> B
    //        -> D@X
    //   -> D@Y
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B',
              peerNames: ['D'],
            },
            { id: 'D@X' },
          ],
        },
        { id: 'D@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(graph);
  });

  it(`should hoist dependencies after hoisting peer dependency`, () => {
    // . -> A -> B --> D@X
    //        -> D@X
    // should be hoisted to (B should be hoisted because its inherited dep D@X was hoisted):
    // . -> A
    //   -> B
    //   -> D@X
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B',
              peerNames: ['D'],
            },
            { id: 'D@X' },
          ],
        },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
        },
        {
          id: 'B',
          peerNames: ['D'],
        },
        { id: 'D@X' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should support basic cyclic peer dependencies', () => {
    //   -> D -> A --> B
    //        -> B --> C
    //        -> C --> A
    // Should be hoisted to:
    //   -> D
    //   -> A
    //   -> B
    //   -> C
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'D',
          dependencies: [
            { id: 'A', peerNames: ['B'] },
            { id: 'B', peerNames: ['C'] },
            { id: 'C', peerNames: ['A'] },
          ],
        },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        { id: 'A', peerNames: ['B'] },
        { id: 'B', peerNames: ['C'] },
        { id: 'C', peerNames: ['A'] },
        { id: 'D' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should support partially hoistable cyclic peer dependencies', () => {
    // . -> E@X
    //   -> D -> A --> B
    //        -> B --> C
    //        -> C --> A
    //             --> E@Y
    //        -> E@Y
    // Should be hoisted to:
    // . -> E@X
    //   -> D -> A
    //        -> B
    //        -> C
    //        -> E@Y
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'D',
          dependencies: [
            { id: 'A', peerNames: ['B'] },
            { id: 'B', peerNames: ['C'] },
            { id: 'C', peerNames: ['A', 'E'] },
            { id: 'E@Y' },
          ],
        },
        { id: 'E@X' },
      ],
    };

    expect(hoist(graph)).toEqual(graph);
  });

  it(`should respect transitive peer dependencies mixed with direct peer dependencies`, () => {
    // . -> A -> B --> C
    //             -> D --> C
    //                  --> E
    //             -> E
    //        -> C@X
    //   -> C@Y
    // should be hoisted to:
    // . -> A -> B --> C
    //        -> C@X
    //        -> D --> C
    //             --> E
    //   -> C@Y
    //   -> E
    // B and D cannot be hoisted to the top, otherwise they will use C@Y, instead of C@X
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B',
              dependencies: [
                {
                  id: 'D',
                  peerNames: ['C', 'E'],
                },
                { id: 'E' },
              ],
              peerNames: ['C'],
            },
            { id: 'C@X' },
          ],
        },
        { id: 'C@Y' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            {
              id: 'B',
              peerNames: ['C'],
            },
            { id: 'C@X' },
            {
              id: 'D',
              peerNames: ['C', 'E'],
            },
          ],
        },
        { id: 'C@Y' },
        { id: 'E' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should support two branch circular graph hoisting`, () => {
    // . -> B -> D@X -> F@X
    //               -> E@X -> D@X
    //                      -> F@X
    //   -> C -> D@Y -> F@Y
    //               -> E@Y -> D@Y
    //                      -> F@Y
    // should be hoisted to:
    // . -> B
    //   -> C -> D@Y -> E@Y
    //        -> F@Y
    //   -> D@X
    //   -> E@X
    //   -> F@X
    // This graph with two similar circular branches should be hoisted in a finite time
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'B',
          dependencies: [
            {
              id: 'D@X',
              dependencies: [
                { id: 'F@X' },
                {
                  id: 'E@X',
                  dependencies: [{ id: 'D@X' }, { id: 'F@X' }],
                },
              ],
            },
          ],
        },
        {
          id: 'C',
          dependencies: [
            {
              id: 'D@Y',
              dependencies: [
                { id: 'F@Y' },
                {
                  id: 'E@Y',
                  dependencies: [{ id: 'D@Y' }, { id: 'F@Y' }],
                },
              ],
            },
          ],
        },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        { id: 'B' },
        {
          id: 'C',
          dependencies: [
            {
              id: 'D@Y',
              dependencies: [{ id: 'E@Y' }],
            },
            { id: 'F@Y' },
          ],
        },
        { id: 'D@X' },
        { id: 'E@X' },
        { id: 'F@X' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it(`should hoist dependencies that peer depend on their parent`, () => {
    // . -> C -> A -> B --> A
    // should be hoisted to:
    // . -> A
    //   -> B
    //   -> C
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'C',
          dependencies: [
            {
              id: 'A',
              dependencies: [
                {
                  id: 'B',
                  peerNames: ['A'],
                },
              ],
            },
          ],
        },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        { id: 'A' },
        {
          id: 'B',
          peerNames: ['A'],
        },
        { id: 'C' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should support portals with contradicting hoist priorities in different parts of the graph', () => {
    // . -> w1 -> A@X -> E@Y
    //         -> B@X -> E@Y
    //         -> p1@X -> E@X
    //   -> w2 -> C@X -> E@X
    //         -> D@X -> E@X
    //         -> p2@X -> E@Y
    //   -> A@Y
    //   -> B@Y
    //   -> C@Y
    //   -> D@Y
    //   -> E@Z
    //   -> p1@Y
    //   -> p2@Y
    // should be hoisted to:
    // . -> w1 -> A@X -> E@Y
    //         -> B@X -> E@Y
    //         -> E@X
    //         -> p1@X
    //   -> w2 -> C@X -> E@X
    //         -> D@X -> E@X
    //         -> E@Y
    //         -> p2@X
    //   -> A@Y
    //   -> B@Y
    //   -> C@Y
    //   -> D@Y
    //   -> E@Z
    //   -> p1@Y
    //   -> p2@Y
    const graph: Graph = {
      id: '.',
      workspaces: [
        {
          id: 'w1',
          dependencies: [
            { id: 'p1@X', dependencies: [{ id: 'E@X' }], packageType: PackageType.PORTAL },
            { id: 'A@X', dependencies: [{ id: 'E@Y' }] },
            { id: 'B@X', dependencies: [{ id: 'E@Y' }] },
          ],
        },
        {
          id: 'w2',
          dependencies: [
            { id: 'p2@X', dependencies: [{ id: 'E@Y' }], packageType: PackageType.PORTAL },
            { id: 'C@X', dependencies: [{ id: 'E@X' }] },
            { id: 'D@X', dependencies: [{ id: 'E@X' }] },
          ],
        },
      ],
      dependencies: [
        { id: 'A@Y' },
        { id: 'B@Y' },
        { id: 'C@Y' },
        { id: 'D@Y' },
        { id: 'E@Z' },
        { id: 'p1@Y' },
        { id: 'p2@Y' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      workspaces: [
        {
          id: 'w1',
          dependencies: [
            { id: 'A@X', dependencies: [{ id: 'E@Y' }] },
            { id: 'B@X', dependencies: [{ id: 'E@Y' }] },
            { id: 'E@X' },
            { id: 'p1@X', packageType: PackageType.PORTAL },
          ],
        },
        {
          id: 'w2',
          dependencies: [
            { id: 'C@X', dependencies: [{ id: 'E@X' }] },
            { id: 'D@X', dependencies: [{ id: 'E@X' }] },
            { id: 'E@Y' },
            { id: 'p2@X', packageType: PackageType.PORTAL },
          ],
        },
      ],
      dependencies: [
        { id: 'A@Y' },
        { id: 'B@Y' },
        { id: 'C@Y' },
        { id: 'D@Y' },
        { id: 'E@Z' },
        { id: 'p1@Y' },
        { id: 'p2@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should support aliases hoisting', () => {
    // . -> A@X -> B -> C(A@X)
    //   -> C@Y
    // should be hoisted to:
    // . -> A@X -> B
    //          -> C(A@X)
    //   -> C@Y
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A@X',
          dependencies: [
            {
              id: 'B',
              dependencies: [
                {
                  id: 'A@X',
                  alias: 'C',
                },
              ],
            },
          ],
        },
        { id: 'C@Y' },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A@X',
        },
        {
          id: 'B',
          dependencies: [
            {
              id: 'A@X',
              alias: 'C',
            },
          ],
        },
        { id: 'C@Y' },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should support hoist walls', () => {
    // . -> D -> A| -> B -> C
    // should be hoisted to:
    // . -> A -> B
    //        -> C
    //   -> D
    const graph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'D',
          dependencies: [
            {
              id: 'A',
              wall: true,
              dependencies: [
                {
                  id: 'B',
                  dependencies: [
                    {
                      id: 'C',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const hoistedGraph: Graph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          wall: true,
          dependencies: [{ id: 'B' }, { id: 'C' }],
        },
        {
          id: 'D',
        },
      ],
    };

    expect(hoist(graph)).toEqual(hoistedGraph);
  });

  it('should hoist workspaces based on their nesting', () => {
    // . -> B@Y
    //   -> w1@X
    //   -> w1 -> B@X
    //   -> w2 -> w1 -> B@X
    // should not be changed by hoisting
    const w1 = { id: 'w1', dependencies: [{ id: 'B@X' }] };
    const graph: Graph = {
      id: '.',
      dependencies: [{ id: 'B@Y' }, { id: 'w1@X' }],
      workspaces: [w1, { id: 'w2', dependencies: [w1] }],
    };

    expect(hoist(graph)).toEqual(graph);
  });
});
