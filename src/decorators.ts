/**
 * Keeps a GraphQL `@Query`, `@Mutation` or `@ResolveField` out of the
 * unused-GraphQL report although no frontend selects it, e.g. a development-only
 * debug query. The reason is required so the exception explains itself.
 *
 * It does nothing at runtime: the check finds it in the resolver source, so
 * import it under this name, never an alias.
 */
export const KeepUnused =
  (_reason: string): MethodDecorator =>
  () => {}
