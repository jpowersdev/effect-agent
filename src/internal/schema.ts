/**
 * Schemas that let options cross a process boundary.
 *
 * @internal
 */
import { Duration, Option, Schema, SchemaGetter } from "effect"

const isDurationInput = (u: unknown): u is Duration.Input => Option.isSome(Duration.fromInput(u as Duration.Input))

/** Millis; an infinite duration as `"Infinity"` or `"-Infinity"`, which JSON (having no infinities) would otherwise turn into `null`. */
const encodeMillis = (input: Duration.Input): string | number => {
  const millis = Duration.toMillis(Duration.fromInputUnsafe(input))
  return Number.isFinite(millis) ? millis : String(millis)
}

/**
 * A `Duration.Input` (`"30 seconds"`, millis, a `Duration`, ...), encoded as
 * millis so it can cross a process boundary (an infinite one as
 * `"Infinity"` or `"-Infinity"`). Decodes millis or `Duration` text.
 *
 * @since 0.2.0
 * @category models
 */
export const DurationInput = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.check(Schema.makeFilter(isDurationInput)),
  Schema.decodeTo(Schema.declare(isDurationInput), {
    decode: SchemaGetter.transform((spec) => Duration.fromInputUnsafe(spec as Duration.Input)),
    encode: SchemaGetter.transform(encodeMillis),
  }),
)

/**
 * Environment overrides: `undefined` removes a variable. Encoded with `null` for `undefined`.
 *
 * @since 0.2.0
 * @category models
 */
export const EnvOverrides = Schema.Record(Schema.String, Schema.NullOr(Schema.String)).pipe(
  Schema.decodeTo(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)), {
    decode: SchemaGetter.transform((env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v ?? undefined]))),
    encode: SchemaGetter.transform((env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v ?? null]))),
  }),
)
