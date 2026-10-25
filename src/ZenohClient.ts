// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * ZenohClient — roadmap-as-code skeleton.
 *
 * The Zenoh transport is planned for v0.3.0 of `ros-mobile-bridge`. Every
 * method signature in this file matches `IProtocolClient` so a future
 * implementation has its surface area written down; every method body
 * throws `Not implemented; v0.3.0`. The class is deliberately not exported
 * from `src/index.ts` in v0.1.0.
 *
 * `ProtocolManager.connect` throws a clear "Zenoh support is planned for
 * v0.3.0" error when called with `protocol: 'zenoh'`, so the only way to
 * reach this stub is to read the source — which is the intent. The file
 * documents what the v0.3.0 implementation must cover.
 *
 * The planned implementation will use `@eclipse-zenoh/zenoh-ts` as the
 * transport dependency (raw Zenoh client over WebSocket to
 * `zenoh-plugin-remote-api`) with a ROS 2 integration layer mapping ROS
 * topic names to Zenoh key-expressions via the `rmw_zenoh` convention and
 * decoding CDR for ROS 2 message payloads.
 */

import type {
  ActionGoalHandle,
  CallServiceOptions,
  CircuitBreakerState,
  ConnectOptions,
  ConnectionStatus,
  IProtocolClient,
  ListParametersOptions,
  ParameterAtomicResult,
  ParameterChange,
  ParameterDescription,
  ParameterReading,
  ParameterSetResult,
  PublishOptions,
  PublishPermission,
  RosMessage,
  SchemaDefinition,
  SendActionGoalOptions,
  ServiceInfo,
  SubscribeOptions,
  SubscriptionState,
  SubscriptionStats,
  TopicEndpoints,
  TopicInfo,
} from './types';

const NOT_IMPLEMENTED = (): Error => new Error('Not implemented; v0.3.0');

export class ZenohClient implements IProtocolClient {
  get isConnected(): boolean {
    throw NOT_IMPLEMENTED();
  }

  get reconnectAttempt(): number {
    throw NOT_IMPLEMENTED();
  }

  get maxReconnectAttempts(): number {
    throw NOT_IMPLEMENTED();
  }

  getLastError(): Error | null {
    throw NOT_IMPLEMENTED();
  }

  getPublishPermission(): PublishPermission {
    // No Zenoh signal for this is known yet (ADR 0022): 'unknown' until the
    // transport establishes one.
    return 'unknown';
  }

  getLinkBacklogMs(): number | null {
    // ADR 0028: the sample's HLC timestamp, when the router stamps samples.
    // Not known until the transport reads one.
    return null;
  }

  async connect(_url: string, _options?: ConnectOptions): Promise<void> {
    throw NOT_IMPLEMENTED();
  }

  async disconnect(): Promise<void> {
    throw NOT_IMPLEMENTED();
  }

  async getAvailableTopics(): Promise<TopicInfo[]> {
    throw NOT_IMPLEMENTED();
  }

  /**
   * Planned (ADR 0025 decision 8): behind `readTopicEndpoints`, one
   * `liveliness().get('@ros2_lv/**')` read; publishers from `MP` tokens,
   * subscribers from `MS`, this client's own entities left out, and a failed
   * read answers not known.
   */
  async getTopicEndpoints(_topics?: readonly string[]): Promise<TopicEndpoints[]> {
    throw NOT_IMPLEMENTED();
  }

  subscribe(
    _topic: string,
    _onMessage: (msg: RosMessage) => void,
    _options?: SubscribeOptions,
  ): () => void {
    throw NOT_IMPLEMENTED();
  }

  getSubscriptionState(_topic: string): SubscriptionState {
    throw NOT_IMPLEMENTED();
  }

  publish(
    _topic: string,
    _schemaName: string,
    _data: Record<string, unknown>,
    _options?: PublishOptions,
  ): void {
    throw NOT_IMPLEMENTED();
  }

  ensureAdvertised(_topic: string, _schemaName: string): void {
    throw NOT_IMPLEMENTED();
  }

  unadvertise(_topic: string): void {
    throw NOT_IMPLEMENTED();
  }

  getBreakerState(_topic: string): CircuitBreakerState {
    throw NOT_IMPLEMENTED();
  }

  getBreakerNextRetryAt(_topic: string): number | null {
    throw NOT_IMPLEMENTED();
  }

  getSubscriptionStats(_topic: string): SubscriptionStats | null {
    throw NOT_IMPLEMENTED();
  }

  breakerRetry(_topic: string): void {
    throw NOT_IMPLEMENTED();
  }

  breakerDisable(_topic: string): void {
    throw NOT_IMPLEMENTED();
  }

  onBreakerStateChange(_topic: string, _cb: (state: CircuitBreakerState) => void): () => void {
    throw NOT_IMPLEMENTED();
  }

  async callService(
    _service: string,
    _request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw NOT_IMPLEMENTED();
  }

  // v0.3.0 obligation (ADR 0006): `rmw_zenoh` maps action internals onto
  // services and topics over key expressions, so the LCD dispatch contract
  // is satisfiable on this transport.
  sendActionGoal(
    _action: string,
    _actionType: string,
    _goal: Record<string, unknown>,
    _options?: SendActionGoalOptions,
  ): ActionGoalHandle {
    throw NOT_IMPLEMENTED();
  }

  getAvailableServices(): ServiceInfo[] {
    throw NOT_IMPLEMENTED();
  }

  onServicesChange(_cb: (services: ServiceInfo[]) => void): () => void {
    throw NOT_IMPLEMENTED();
  }

  // Planned (ADR 0021): the shared parameters.ts over this client's
  // callService, with service names read from liveliness tokens. Under
  // rmw_zenoh the per-node parameter services are the only parameter route.

  async getParameterNodes(_options?: CallServiceOptions): Promise<string[]> {
    throw NOT_IMPLEMENTED();
  }

  async listParameters(_node: string, _options?: ListParametersOptions): Promise<string[]> {
    throw NOT_IMPLEMENTED();
  }

  async getParameters(
    _node: string,
    _names: readonly string[],
    _options?: CallServiceOptions,
  ): Promise<ParameterReading[]> {
    throw NOT_IMPLEMENTED();
  }

  async describeParameters(
    _node: string,
    _names: readonly string[],
    _options?: CallServiceOptions,
  ): Promise<ParameterDescription[]> {
    throw NOT_IMPLEMENTED();
  }

  async setParameters(
    _node: string,
    _changes: readonly ParameterChange[],
    _options?: CallServiceOptions,
  ): Promise<ParameterSetResult[]> {
    throw NOT_IMPLEMENTED();
  }

  async setParametersAtomically(
    _node: string,
    _changes: readonly ParameterChange[],
    _options?: CallServiceOptions,
  ): Promise<ParameterAtomicResult> {
    throw NOT_IMPLEMENTED();
  }

  getSchemaTemplate(_schemaName: string): Record<string, unknown> | null {
    throw NOT_IMPLEMENTED();
  }

  async getSchemaDefinition(_schemaName: string): Promise<SchemaDefinition | null> {
    throw NOT_IMPLEMENTED();
  }

  onStatusChange(_cb: (status: ConnectionStatus) => void): () => void {
    throw NOT_IMPLEMENTED();
  }

  onTopicsChange(_cb: (topics: TopicInfo[]) => void): () => void {
    throw NOT_IMPLEMENTED();
  }

  onLog(_cb: (log: string) => void): () => void {
    throw NOT_IMPLEMENTED();
  }
}
