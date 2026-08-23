import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

const messageSchema = z.object({
  seq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnStartSeq: z.number().int().nonnegative(),
  turnEndSeq: z.number().int().nonnegative(),
  text: z.string(),
  time: z.number().int().nonnegative(),
}).strict()

const modelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().int().nonnegative().optional(),
  reasoningEffort: z.string().optional(),
}).strict()

const branchNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  parentSeq: z.number().int().nonnegative().optional(),
  turn: z.number().int().nonnegative(),
  turnStartSeq: z.number().int().nonnegative(),
  turnEndSeq: z.number().int().nonnegative(),
  text: z.string(),
  time: z.number().int().nonnegative(),
  path: z.array(z.number().int().nonnegative()),
  branchEnd: z.boolean(),
  current: z.boolean(),
  selectable: z.boolean(),
  unavailableReason: z.string().optional(),
}).strict()

const branchTreeSchema = z.object({
  nodes: z.array(branchNodeSchema),
  currentPath: z.array(z.number().int().nonnegative()),
  currentSeq: z.number().int().nonnegative().optional(),
}).strict()

const sessionViewSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(messageSchema),
  hiddenRanges: z.array(z.object({
    startSeq: z.number().int().nonnegative(),
    endSeq: z.number().int().nonnegative(),
  }).strict()),
  branches: branchTreeSchema,
  model: modelSchema.optional(),
}).strict()

const rewindRequestSchema = z.object({
  sessionId: z.string().min(1),
  messageSeq: z.number().int().nonnegative(),
  text: z.string(),
  cascade: z.enum(['truncate', 'preserve']),
}).strict()

const branchSelectRequestSchema = z.object({
  sessionId: z.string().min(1),
  messageSeq: z.number().int().nonnegative(),
}).strict()

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
  replacementSeq: z.number().int().nonnegative().optional(),
}).strict()

const listResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: sessionViewSchema }).strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
])

const rewindResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({
      sessionId: z.string(),
      replacementSeq: z.number().int().nonnegative(),
      queuedMessages: z.number().int().nonnegative(),
      shadowedMessages: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
])

const branchSelectResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({
      sessionId: z.string(),
      messageSeq: z.number().int().nonnegative(),
      path: z.array(z.number().int().nonnegative()),
      queuedMessages: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
])

/** Strict Remote descriptors shared by Host and browser. */
export const CONVERSATION_REWIND_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: 'dsh-conversation-rewind#conversationRewind/list',
    service: 'conversationRewind',
    namespace: 'conversationRewind',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'sessionId',
      wire: 'sessionId',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        schema: z.string().min(1),
      },
    }],
    cancellation: { parameter: 'signal' },
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-conversation-rewind#RewindBusinessResult<RewindSessionView>',
      schema: listResultSchema,
    },
  },
  {
    id: 'dsh-conversation-rewind#conversationRewind/rewind',
    service: 'conversationRewind',
    namespace: 'conversationRewind',
    method: 'rewind',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: 'dsh-conversation-rewind#RewindRequest',
        schema: rewindRequestSchema,
      },
    }],
    cancellation: { parameter: 'signal' },
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-conversation-rewind#RewindBusinessResult<RewindResult>',
      schema: rewindResultSchema,
    },
  },
  {
    id: 'dsh-conversation-rewind#conversationRewind/select',
    service: 'conversationRewind',
    namespace: 'conversationRewind',
    method: 'select',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: 'dsh-conversation-rewind#RewindBranchSelectRequest',
        schema: branchSelectRequestSchema,
      },
    }],
    cancellation: { parameter: 'signal' },
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-conversation-rewind#RewindBusinessResult<RewindBranchSelectResult>',
      schema: branchSelectResultSchema,
    },
  },
]
