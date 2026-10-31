/**
 * Usage-limit windows (five-hour, weekly), as `Agent.status`, the
 * `LimitsUpdated` event and the `UsageLimited` failure report them.
 *
 * @since 0.3.0
 */
import { Schema } from "effect"

/**
 * Normalized limit window. `other` keeps the provider's name in `label`.
 *
 * @since 0.1.0
 * @category models
 */
export const LimitWindow = Schema.Literals(["five_hour", "weekly", "other"])

/**
 * @since 0.1.0
 * @category models
 */
export type LimitWindow = typeof LimitWindow.Type

/**
 * Usage of one limit window.
 *
 * @since 0.1.0
 * @category models
 */
export const LimitWindowStatus = Schema.Struct({
  window: LimitWindow,
  /** Provider's own name for the window, e.g. `seven_day` or `primary`. */
  label: Schema.String,
  /** 0 to 100. */
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromMillis),
  /**
   * The model family this window caps, lowercase (e.g. `opus`, `fable`);
   * none for a window that applies to every model. Encoded as `null`.
   */
  model: Schema.OptionFromNullOr(Schema.String),
})

/**
 * @since 0.1.0
 * @category models
 */
export type LimitWindowStatus = typeof LimitWindowStatus.Type
