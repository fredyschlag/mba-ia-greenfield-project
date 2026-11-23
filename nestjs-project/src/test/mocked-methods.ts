/**
 * Maps methods to `jest.Mock` properties. Unlike `jest.Mocked<T>`, it does not
 * intersect with `T`, so asserting on a mock is not an unbound method reference.
 */
export type MockedMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : T[K];
};
