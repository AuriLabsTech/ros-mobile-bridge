// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Build a protobuf channel's advertised `schema` (a base64 `FileDescriptorSet`)
 * from descriptor protos written in the test.
 *
 * Only the schema is built with the protobuf runtime. Payloads stay
 * hand-encoded in each test, so a decoded value is always checked against
 * bytes written from the wire format, never against the runtime's own encoder.
 */

import { create, toBinary } from '@bufbuild/protobuf';
import {
  FileDescriptorSetSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import { base64Encode } from '@bufbuild/protobuf/wire';
import type { MessageInitShape } from '@bufbuild/protobuf';

export type FileInit = MessageInitShape<typeof FileDescriptorProtoSchema>;

/** Base64 `FileDescriptorSet` holding `files`, as a server would advertise it. */
export function descriptorSetBase64(...files: FileInit[]): string {
  const set = create(FileDescriptorSetSchema, {
    file: files.map((f) => create(FileDescriptorProtoSchema, f) as FileDescriptorProto),
  });
  return base64Encode(toBinary(FileDescriptorSetSchema, set));
}

/** `FieldDescriptorProto.Type` values used by the tests. */
export const T = {
  DOUBLE: 1,
  INT64: 3,
  UINT64: 4,
  INT32: 5,
  BOOL: 8,
  STRING: 9,
  MESSAGE: 11,
  BYTES: 12,
  ENUM: 14,
} as const;

/** `FieldDescriptorProto.Label` values. */
export const L = { OPTIONAL: 1, REPEATED: 3 } as const;
