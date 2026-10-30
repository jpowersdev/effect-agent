/**
 * Sessions that outlive the process that started them: each runs in its own
 * host process, and any process can reattach to it by session id.
 *
 * @since 0.1.0
 */

/**
 * What a host process is started with, and where hosts live on disk.
 *
 * @since 0.1.0
 * @category modules
 */
export * as HostSpec from "./HostSpec.ts"

/**
 * The RPC group a host serves over its unix socket.
 *
 * @since 0.1.0
 * @category modules
 */
export * as HostProtocol from "./protocol.ts"

export {
  /**
   * @since 0.1.0
   * @category re-exports
   */
  EventsTrimmed,
  /**
   * @since 0.1.0
   * @category re-exports
   */
  type HostInfo,
  /**
   * @since 0.1.0
   * @category re-exports
   */
  type SeqEvent,
} from "./protocol.ts"

/**
 * Sessions that outlive the process that started them.
 *
 * @since 0.1.0
 * @category modules
 */
export * as RemoteAgent from "./RemoteAgent.ts"

export {
  /**
   * @since 0.1.0
   * @category re-exports
   */
  AgentHosts,
  /**
   * @since 0.1.0
   * @category re-exports
   */
  type RemoteSession,
} from "./RemoteAgent.ts"

/**
 * The program a session host process runs.
 *
 * @since 0.1.0
 * @category modules
 */
export * as SessionHost from "./SessionHost.ts"
