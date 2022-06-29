import { Package, hoist } from '../src';

describe('hoist', () => {
  it('should do very basic hoisting', () => {
    // . -> A -> B
    // should be hoisted to:
    // . -> A
    //   -> B
    const graph = {
      id: '.',
      dependencies: [{ id: 'A', dependencies: [{ id: 'B' }] }],
    };

    const hoistedGraph = {
      id: '.',
      dependencies: [{ id: 'A' }, { id: 'B' }],
    };

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
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
    const graph = {
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

    const hoistedGraph = {
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

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
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
    const graph = {
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

    const hoistedGraph = {
      id: '.',
      dependencies: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
    };

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
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
    const BX = { id: 'B@X', dependencies: [{ id: 'C@X' }] };
    const graph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [BX, { id: 'C@Y' }] },
        { id: 'D', dependencies: [BX] },
        { id: 'B@Y' },
        { id: 'C@Z' },
      ],
    };

    const hoistedGraph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'B@X', dependencies: [{ id: 'C@X' }] }, { id: 'C@Y' }] },
        { id: 'B@Y' },
        { id: 'C@Z' },
        { id: 'D', dependencies: [{ id: 'B@X' }] },
      ],
    };

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
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
    const graph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'B@X', dependencies: [{ id: 'E@X' }] }] },
        { id: 'B@Y' },
        { id: 'C', dependencies: [{ id: 'E@Y' }] },
        { id: 'D', dependencies: [{ id: 'E@Y' }] },
      ],
    };

    const hoistedGraph = {
      id: '.',
      dependencies: [
        { id: 'A', dependencies: [{ id: 'B@X' }, { id: 'E@X' }] },
        { id: 'B@Y' },
        { id: 'C' },
        { id: 'D' },
        { id: 'E@Y' },
      ],
    };

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
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
    const graph = {
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

    const hoistedGraph = {
      id: '.',
      dependencies: [
        {
          id: 'A',
          dependencies: [
            { id: 'B@X' },
            { id: 'H@X' },
            {
              id: 'I@X',
              dependencies: [
                {
                  id: 'B@Z',
                },
              ],
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

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
  });

  it(`should handle conflict with original dependencies after dependencies hoisting`, () => {
    // . -> A -> B@X -> C@X -> D@X
    //        -> D@Y
    //   -> B@Y
    //   -> E -> C@Y
    //        -> D@X
    //   -> F -> C@Y
    // should be hoisted to:
    // . -> A -> B@X -> C@X (-> D@X)
    //        -> D@Y
    //   -> B@Y
    //   -> C@Y
    //   -> D@X
    //   -> E
    //   -> F
    const graph = {
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
        { id: 'E', dependencies: [{ id: 'C@Y' }, { id: 'D@X' }] },
        { id: 'F', dependencies: [{ id: 'C@Y' }] },
      ],
    };

    const hoistedGraph = {
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
                },
              ],
            },
            { id: 'D@Y' },
          ],
        },
        { id: 'B@Y' },
        { id: 'C@Y' },
        { id: 'D@X' },
        { id: 'E' },
        { id: 'F' },
      ],
    };

    expect(hoist(graph as Package)).toEqual(hoistedGraph);
  });

  it(`should support basic peer dependencies`, () => {
    // . -> A -> B --> D
    //        -> D@X
    //   -> D@Y
    // should be hoisted to (A and B should share single D@X dependency):
    // . -> A -> B
    //        -> D@X
    //   -> D@Y
    const graph = {
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
    expect(hoist(graph as Package)).toEqual(graph);
  });

  it(`should hoist dependencies after hoisting peer dependency`, () => {
    // . -> A -> B --> D@X
    //        -> D@X
    // should be hoisted to (B should be hoisted because its inherited dep D@X was hoisted):
    // . -> A
    //   -> B
    //   -> D@X
    const graph = {
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

    const hoistedGraph = {
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
    expect(hoist(graph as Package)).toEqual(hoistedGraph);
  });
});
