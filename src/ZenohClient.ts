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
  CircuitBreakerState,
  ConnectionStatus,
  IProtocolClient,
  PublishOptions,
  RosMessage,
  ServiceInfo,
  SubscribeOptions,
  SubscriptionStats,
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

  async connect(_url: string): Promise<void> {
    throw NOT_IMPLEMENTED();
  }

  async disconnect(): Promise<void> {
    throw NOT_IMPLEMENTED();
  }

  async getAvailableTopics(): Promise<TopicInfo[]> {
    throw NOT_IMPLEMENTED();
  }

  subscribe(
    _topic: string,
    _onMessage: (msg: RosMessage) => void,
    _options?: SubscribeOptions,
  ): () => void {
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

  publishZeroTwist(): void {
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

  onBreakerStateChange(
    _topic: string,
    _cb: (state: CircuitBreakerState) => void,
  ): () => void {
    throw NOT_IMPLEMENTED();
  }

  async callService(
    _service: string,
    _request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw NOT_IMPLEMENTED();
  }

  getAvailableServices(): ServiceInfo[] {
    throw NOT_IMPLEMENTED();
  }

  onServicesChange(_cb: (services: ServiceInfo[]) => void): () => void {
    throw NOT_IMPLEMENTED();
  }

  getSchemaTemplate(_schemaName: string): Record<string, unknown> | null {
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
