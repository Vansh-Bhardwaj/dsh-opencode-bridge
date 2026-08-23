// src/core.ts
import {
  foldSurface,
  isReplacementSurfaceEvent
} from "@deepseek-ai/dsh-session";
var REWIND_MARKER_KIND = "dsh-conversation-rewind";
var REWIND_MARKER_VERSION = 1;
var REWIND_MARKER_PROVIDER = "dsh-conversation-rewind";
var REWIND_MARKER_MODEL = "surface-rewind";
var REWIND_REPLAY_MARKER_KEYS = [
  "kind",
  "version",
  "transactionId",
  "targetSeq",
  "mode"
];
function hasExactOwnKeys(value, keys) {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === "string" && keys.includes(key));
}
var ConversationRewindError = class extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
  name = "ConversationRewindError";
};
function fail(code, message, status = 400) {
  throw new ConversationRewindError(code, message, status);
}
function analyzeTurns(events) {
  const closed = [];
  let current;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      fail("INVALID_SESSION", `session event ${String(index)} has seq ${String(event.seq)}`, 409);
    }
    if (event.type === "turn/start") {
      if (current !== void 0) {
        fail("INVALID_SESSION", `turn ${String(current.turn)} is still open`, 409);
      }
      current = {
        turn: event.data.turn,
        startIndex: index,
        startSeq: event.seq,
        userMessages: [],
        humanMessages: []
      };
      continue;
    }
    if (event.type === "user/message" && current !== void 0) {
      current.userMessages.push(event);
      if (event.data.source.kind === "user") current.humanMessages.push(event);
      continue;
    }
    if (event.type !== "turn/end") continue;
    if (current === void 0 || current.turn !== event.data.turn) {
      fail("INVALID_SESSION", `turn/end ${String(event.data.turn)} has no matching turn/start`, 409);
    }
    closed.push({
      ...current,
      endIndex: index,
      endSeq: event.seq
    });
    current = void 0;
  }
  return { closed, openTurn: current?.turn ?? null };
}
function plainUserText(event) {
  if (event.data.source.kind !== "user" || event.data.content.length !== 1) return void 0;
  const block = event.data.content[0];
  return block?.type === "text" ? block.text : void 0;
}
function isRegeneratedContext(event) {
  const source = event.data.source;
  return source.kind === "plugin" && source.plugin === "@deepseek-ai/dsh-system-prompt" && source.form === "snapshot" || source.kind === "skill-catalog" && source.form === "catalog";
}
function editableTurn(turn) {
  if (turn.humanMessages.length !== 1) return void 0;
  const event = turn.humanMessages[0];
  if (event === void 0) return void 0;
  const text = plainUserText(event);
  if (text === void 0) return void 0;
  return {
    seq: event.seq,
    turn: turn.turn,
    turnStartSeq: turn.startSeq,
    turnEndSeq: turn.endSeq,
    text,
    time: event.time
  };
}
function hasReplaySafeTargetSurface(turn, target, surface) {
  if (turn.humanMessages.length !== 1 || turn.humanMessages[0]?.seq !== target.seq) return false;
  const targetIndex = turn.userMessages.findIndex((event) => event.seq === target.seq);
  if (targetIndex < 0) return false;
  return turn.userMessages.slice(targetIndex + 1).every((event) => !surface.has(event.seq) || isRegeneratedContext(event));
}
function hasReplaySafeTailSurface(turn, human, surface) {
  return turn.userMessages.every((event) => !surface.has(event.seq) || event.seq === human.seq || isRegeneratedContext(event));
}
function latestCallConfig(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "request/header") return event.data.header.config;
  }
  return void 0;
}
function messageInsertionIndex(events, target, turnStartIndex) {
  for (let index = turnStartIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "agent/inbox/spliced" || event.data.target !== "next-turn") continue;
    if (!event.data.inserted.some((message) => message.id === target.data.id)) continue;
    if (event.data.inserted.length !== 1) return void 0;
    return index;
  }
  return void 0;
}
function projectModel(events) {
  const config = latestCallConfig(events);
  if (config === void 0) return void 0;
  return {
    provider: config.provider,
    model: config.model,
    ...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens },
    ...config.reasoningEffort === void 0 ? {} : { reasoningEffort: String(config.reasoningEffort) }
  };
}
function listEditableMessages(events) {
  const surface = new Set(foldSurface(events).nodes);
  const turns = analyzeTurns(events).closed;
  return turns.flatMap((turn) => {
    const projected = editableTurn(turn);
    const target = turn.humanMessages[0];
    if (projected === void 0 || target === void 0) return [];
    if (!surface.has(target.seq) || target.surfaceOp !== "append") return [];
    if (!hasReplaySafeTargetSurface(turn, target, surface)) return [];
    return messageInsertionIndex(events, target, turn.startIndex) === void 0 ? [] : [projected];
  });
}
function historicallySelectableSeqs(events, turns) {
  const selectable = /* @__PURE__ */ new Set();
  for (const turn of turns) {
    const target = turn.humanMessages[0];
    if (target === void 0 || editableTurn(turn) === void 0 || target.surfaceOp !== "append") continue;
    const prefix = events.slice(0, turn.endIndex + 1);
    const surface = new Set(foldSurface(prefix).nodes);
    if (!surface.has(target.seq) || !hasReplaySafeTargetSurface(turn, target, surface)) continue;
    if (messageInsertionIndex(events, target, turn.startIndex) !== void 0) selectable.add(target.seq);
  }
  return selectable;
}
var BRANCH_REPLAY_METADATA_KEYS = ["kind", "version", "transactionId", "originSeq", "text"];
var REWIND_WAKE_PREFIX = "conversation-rewind-wake-";
var BRANCH_UNSAFE_REASON = "this branch crosses a user turn or context that cannot be replayed safely";
var BRANCH_HIDDEN_REASON = "the active divergence message is hidden by compaction or another replacement checkpoint";
function isTransactionId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function branchReplayTransactions(events) {
  const transactions = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced" || event.data.target !== "next-turn" || event.data.inserted.length !== 1 || event.data.removedCount !== void 0 && event.data.removedCount !== 0 || event.data.outcome !== void 0) continue;
    const message = event.data.inserted[0];
    if (message === void 0) continue;
    const source = message.source;
    const block = message.content[0];
    if (!hasExactOwnKeys(source, ["kind", "plugin"]) || source.kind !== "plugin" || source.plugin !== "dsh-conversation-rewind" || message.content.length !== 1 || block === void 0 || !hasExactOwnKeys(block, ["type", "text"]) || block.type !== "text" || !block.text.startsWith(REWIND_WAKE_PREFIX)) continue;
    const transactionId = block.text.slice(REWIND_WAKE_PREFIX.length);
    if (isTransactionId(transactionId) && !transactions.has(transactionId)) {
      transactions.set(transactionId, event.seq);
    }
  }
  return transactions;
}
function branchReplayMetadata(event) {
  if (event.data.source.kind !== "user") return;
  const source = event.data.source;
  const value = source.rewindBranch;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value;
  if (Object.keys(value).length !== BRANCH_REPLAY_METADATA_KEYS.length || !BRANCH_REPLAY_METADATA_KEYS.every((key) => Object.hasOwn(value, key)) || candidate.kind !== "dsh-conversation-rewind-branch-replay" || candidate.version !== 1 || !isTransactionId(candidate.transactionId) || !Number.isSafeInteger(candidate.originSeq) || (candidate.originSeq ?? -1) < 0 || typeof candidate.text !== "string") return;
  return candidate;
}
function branchReplayOrigin(event, parent, views, parentByLogical, trustedTransactions) {
  const metadata = branchReplayMetadata(event);
  const certificateSeq = metadata === void 0 ? void 0 : trustedTransactions.get(metadata.transactionId);
  if (metadata === void 0 || certificateSeq === void 0 || certificateSeq >= event.seq) return;
  const origin = views.get(metadata.originSeq);
  const text = plainUserText(event);
  if (origin === void 0 || !origin.selectable || text === void 0 || text !== metadata.text || text !== origin.text || parentByLogical.get(metadata.originSeq) !== parent) return;
  return metadata.originSeq;
}
function latestLineage(nodes, lineageBySurfaceSeq) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const lineage = lineageBySurfaceSeq.get(nodes[index] ?? -1);
    if (lineage !== void 0) return lineage;
  }
  return;
}
function latestReplaySafe(nodes, replaySafeBySurfaceSeq) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const safe = replaySafeBySurfaceSeq.get(nodes[index] ?? -1);
    if (safe !== void 0) return safe;
  }
  return true;
}
function pathForBranchSeq(seq, bySeq, parentByLogical) {
  const path = [];
  const seen = /* @__PURE__ */ new Set();
  let cursor = seq;
  while (cursor !== void 0) {
    if (seen.has(cursor)) fail("INVALID_SESSION", "the message branch tree contains a cycle", 409);
    if (!bySeq.has(cursor)) fail("INVALID_SESSION", "the message branch tree has a missing parent", 409);
    seen.add(cursor);
    path.push(cursor);
    cursor = parentByLogical.get(cursor);
  }
  path.reverse();
  return path;
}
function visualParentSeq(seq, parentByLogical, childCountByLogical) {
  const seen = /* @__PURE__ */ new Set([seq]);
  let cursor = parentByLogical.get(seq);
  while (cursor !== void 0) {
    if (seen.has(cursor)) fail("INVALID_SESSION", "the message branch tree contains a cycle", 409);
    seen.add(cursor);
    if (parentByLogical.get(cursor) === void 0 || (childCountByLogical.get(cursor) ?? 0) > 1) {
      return cursor;
    }
    cursor = parentByLogical.get(cursor);
  }
  return;
}
function projectBranchState(events) {
  foldSurface(events);
  const turns = analyzeTurns(events).closed;
  const messageBySeq = /* @__PURE__ */ new Map();
  const selectable = historicallySelectableSeqs(events, turns);
  const trustedTransactions = branchReplayTransactions(events);
  for (const turn of turns) {
    const message = editableTurn(turn);
    if (message !== void 0) messageBySeq.set(message.seq, message);
  }
  const surface = [];
  const lineageBySurfaceSeq = /* @__PURE__ */ new Map();
  const replaySafeBySurfaceSeq = /* @__PURE__ */ new Map();
  const logicalByOccurrence = /* @__PURE__ */ new Map();
  const parentByLogical = /* @__PURE__ */ new Map();
  const views = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.type !== "user/message" && event.type !== "assistant/message" && event.type !== "tool/result") continue;
    if (event.surfaceOp === void 0) continue;
    if (event.surfaceOp === "append") {
      const parent = latestLineage(surface, lineageBySurfaceSeq);
      const prefixSafe2 = latestReplaySafe(surface, replaySafeBySurfaceSeq);
      if (event.type === "user/message" && event.data.source.kind === "user") {
        const message = messageBySeq.get(event.seq);
        if (message !== void 0) {
          const origin = prefixSafe2 ? branchReplayOrigin(event, parent, views, parentByLogical, trustedTransactions) : void 0;
          const logicalSeq = origin !== void 0 && views.has(origin) ? origin : event.seq;
          logicalByOccurrence.set(event.seq, logicalSeq);
          if (!views.has(logicalSeq)) {
            const nodeSelectable = selectable.has(event.seq) && prefixSafe2 && (parent === void 0 || views.get(parent)?.selectable === true);
            const unavailableReason = nodeSelectable ? void 0 : BRANCH_UNSAFE_REASON;
            parentByLogical.set(logicalSeq, parent);
            views.set(logicalSeq, {
              seq: logicalSeq,
              ...parent === void 0 ? {} : { parentSeq: parent },
              turn: message.turn,
              turnStartSeq: message.turnStartSeq,
              turnEndSeq: message.turnEndSeq,
              text: message.text,
              time: message.time,
              selectable: nodeSelectable,
              ...unavailableReason === void 0 ? {} : { unavailableReason }
            });
          }
          lineageBySurfaceSeq.set(event.seq, logicalSeq);
          replaySafeBySurfaceSeq.set(
            event.seq,
            prefixSafe2 && views.get(logicalSeq)?.selectable === true
          );
        } else {
          lineageBySurfaceSeq.set(event.seq, parent);
          replaySafeBySurfaceSeq.set(event.seq, false);
        }
      } else {
        lineageBySurfaceSeq.set(event.seq, parent);
        replaySafeBySurfaceSeq.set(
          event.seq,
          prefixSafe2 && (event.type !== "user/message" || isRegeneratedContext(event))
        );
      }
      surface.push(event.seq);
      continue;
    }
    const startIndex = surface.indexOf(event.surfaceOp.start);
    const endIndex = surface.indexOf(event.surfaceOp.end);
    if (startIndex < 0 || endIndex < startIndex) {
      throw new ConversationRewindError("INVALID_SESSION", "branch projection encountered an invalid replacement range", 409);
    }
    const shadowed = surface.slice(startIndex, endIndex + 1);
    const marker = replayMarker(event);
    let lineage;
    if (marker !== void 0) {
      const targetLogical = logicalByOccurrence.get(marker.targetSeq);
      lineage = targetLogical === void 0 ? latestLineage(surface.slice(0, startIndex), lineageBySurfaceSeq) : parentByLogical.get(targetLogical);
    } else {
      lineage = latestLineage(shadowed, lineageBySurfaceSeq) ?? latestLineage(surface.slice(0, startIndex), lineageBySurfaceSeq);
    }
    surface.splice(startIndex, endIndex - startIndex + 1, event.seq);
    lineageBySurfaceSeq.set(event.seq, lineage);
    const prefixSafe = latestReplaySafe(surface.slice(0, startIndex), replaySafeBySurfaceSeq);
    const shadowSafe = latestReplaySafe(shadowed, replaySafeBySurfaceSeq);
    replaySafeBySurfaceSeq.set(event.seq, marker !== void 0 ? prefixSafe : prefixSafe && shadowSafe);
  }
  const currentPathReversed = [];
  const currentSeen = /* @__PURE__ */ new Set();
  let currentCursor = latestLineage(surface, lineageBySurfaceSeq);
  while (currentCursor !== void 0) {
    if (currentSeen.has(currentCursor)) {
      throw new ConversationRewindError("INVALID_SESSION", "the active message lineage contains a cycle", 409);
    }
    currentSeen.add(currentCursor);
    if (!views.has(currentCursor)) break;
    currentPathReversed.push(currentCursor);
    currentCursor = parentByLogical.get(currentCursor);
  }
  const currentPath = currentPathReversed.reverse();
  const current = new Set(currentPath);
  const activeLogical = /* @__PURE__ */ new Set();
  for (const seq of surface) {
    const logical = logicalByOccurrence.get(seq);
    if (logical !== void 0) activeLogical.add(logical);
  }
  const childCountByLogical = /* @__PURE__ */ new Map();
  for (const parent of parentByLogical.values()) {
    if (parent === void 0) continue;
    childCountByLogical.set(parent, (childCountByLogical.get(parent) ?? 0) + 1);
  }
  const baseBySeq = new Map([...views.values()].map((node) => {
    const displayParent = visualParentSeq(node.seq, parentByLogical, childCountByLogical);
    return [node.seq, {
      seq: node.seq,
      ...displayParent === void 0 ? {} : { parentSeq: displayParent },
      turn: node.turn,
      turnStartSeq: node.turnStartSeq,
      turnEndSeq: node.turnEndSeq,
      text: node.text,
      time: node.time,
      path: pathForBranchSeq(node.seq, views, parentByLogical),
      branchEnd: (childCountByLogical.get(node.seq) ?? 0) === 0,
      current: current.has(node.seq),
      selectable: node.selectable,
      ...node.unavailableReason === void 0 ? {} : { unavailableReason: node.unavailableReason }
    }];
  }));
  const projectedBySeq = new Map(baseBySeq);
  for (const node of baseBySeq.values()) {
    if (!node.selectable) continue;
    const desiredPath = pathForBranchSeq(node.seq, baseBySeq, parentByLogical);
    let common = 0;
    while (common < currentPath.length && common < desiredPath.length && currentPath[common] === desiredPath[common]) common += 1;
    if (common >= currentPath.length) continue;
    const targetLogical = currentPath[common];
    const targetNode = targetLogical === void 0 ? void 0 : baseBySeq.get(targetLogical);
    const reason = targetLogical === void 0 || !activeLogical.has(targetLogical) ? BRANCH_HIDDEN_REASON : targetNode?.selectable !== true ? targetNode?.unavailableReason ?? BRANCH_UNSAFE_REASON : void 0;
    if (reason !== void 0) {
      projectedBySeq.set(node.seq, {
        ...node,
        selectable: false,
        unavailableReason: reason
      });
    }
  }
  const nodes = [...projectedBySeq.values()].sort((left, right) => left.time - right.time || left.seq - right.seq).map((node) => node);
  const currentSeq = currentPath.at(-1);
  return {
    tree: {
      nodes,
      currentPath,
      ...currentSeq === void 0 ? {} : { currentSeq }
    },
    parentByLogical
  };
}
function projectBranchTree(events) {
  return projectBranchState(events).tree;
}
function validateBranchRequest(request) {
  if (request.sessionId.trim() === "") fail("INVALID_REQUEST", "sessionId is required");
  if (!Number.isSafeInteger(request.messageSeq) || request.messageSeq < 0) {
    fail("INVALID_REQUEST", "messageSeq must be a non-negative safe integer");
  }
}
function queryConversationBranch(snapshot, request) {
  validateBranchRequest(request);
  if (snapshot.session.id !== request.sessionId) {
    fail("INVALID_REQUEST", "sessionId does not match the loaded Session", 409);
  }
  const tree = projectBranchTree(snapshot.events);
  const selected = tree.nodes.find((node) => node.seq === request.messageSeq);
  if (selected === void 0) {
    fail("MESSAGE_NOT_FOUND", `branch message seq ${String(request.messageSeq)} is unavailable`, 404);
  }
  if (!selected.branchEnd) {
    fail("BRANCH_NOT_ENDPOINT", "only the final message of a conversation branch can be opened", 409);
  }
  return {
    messageSeq: selected.seq,
    currentPath: [...tree.currentPath],
    desiredPath: [...selected.path]
  };
}
function buildBranchSelectionPlan(snapshot, request) {
  validateBranchRequest(request);
  if (snapshot.session.id !== request.sessionId) {
    fail("INVALID_REQUEST", "sessionId does not match the loaded Session", 409);
  }
  const analysis = analyzeTurns(snapshot.events);
  if (analysis.openTurn !== null) {
    fail("SOURCE_BUSY", `turn ${String(analysis.openTurn)} is still running`, 409);
  }
  const projection = projectBranchState(snapshot.events);
  const tree = projection.tree;
  const bySeq = new Map(tree.nodes.map((node) => [node.seq, node]));
  const selected = bySeq.get(request.messageSeq);
  if (selected === void 0) {
    fail("MESSAGE_NOT_FOUND", `branch message seq ${String(request.messageSeq)} is unavailable`, 404);
  }
  if (!selected.selectable) {
    fail(
      "BRANCH_UNAVAILABLE",
      selected.unavailableReason ?? "the selected branch cannot be replayed safely",
      409
    );
  }
  const desiredPath = pathForBranchSeq(selected.seq, bySeq, projection.parentByLogical);
  let common = 0;
  while (common < tree.currentPath.length && common < desiredPath.length && tree.currentPath[common] === desiredPath[common]) common += 1;
  const surfaceNodes = [...foldSurface(snapshot.events).nodes];
  const trustedTransactions = branchReplayTransactions(snapshot.events);
  let targetSeq;
  if (common < tree.currentPath.length) {
    const targetLogical = tree.currentPath[common];
    const targetNode = bySeq.get(targetLogical);
    for (const seq of surfaceNodes) {
      const event = snapshot.events[seq];
      if (event?.type !== "user/message" || event.data.source.kind !== "user") continue;
      const metadata = branchReplayMetadata(event);
      const text = plainUserText(event);
      const certificateSeq = metadata === void 0 ? void 0 : trustedTransactions.get(metadata.transactionId);
      const isOriginOccurrence = metadata !== void 0 && certificateSeq !== void 0 && certificateSeq < event.seq && metadata.originSeq === targetLogical && targetNode !== void 0 && text === metadata.text && text === targetNode.text;
      if (event.seq === targetLogical || isOriginOccurrence) {
        targetSeq = event.seq;
        break;
      }
    }
    if (targetSeq === void 0) {
      fail("BRANCH_UNAVAILABLE", BRANCH_HIDDEN_REASON, 409);
    }
    const currentNode = targetLogical === void 0 ? void 0 : bySeq.get(targetLogical);
    buildRewindPlan(snapshot, {
      sessionId: request.sessionId,
      messageSeq: targetSeq,
      text: currentNode?.text ?? selected.text,
      cascade: "truncate"
    });
  }
  const followups = desiredPath.slice(common).map((seq) => {
    const node = bySeq.get(seq);
    if (node === void 0 || !node.selectable) {
      fail("BRANCH_UNAVAILABLE", "the selected branch contains a message that cannot be replayed safely", 409);
    }
    return { originSeq: node.seq, text: node.text };
  });
  return {
    messageSeq: selected.seq,
    currentPath: [...tree.currentPath],
    desiredPath,
    ...targetSeq === void 0 ? {} : { targetSeq },
    surfaceNodes,
    followups
  };
}
function validateRequest(request) {
  if (request.sessionId.trim() === "") fail("INVALID_REQUEST", "sessionId is required");
  if (!Number.isSafeInteger(request.messageSeq) || request.messageSeq < 0) {
    fail("INVALID_REQUEST", "messageSeq must be a non-negative safe integer");
  }
  if (request.text.trim() === "") fail("INVALID_REQUEST", "edited text must not be blank");
  if (request.cascade !== "truncate" && request.cascade !== "preserve") {
    fail("INVALID_REQUEST", 'cascade must be "truncate" or "preserve"');
  }
}
function preservedTail(events, turns, targetIndex, surface, tailSurfaceNodes) {
  for (const seq of tailSurfaceNodes) {
    const event = events[seq];
    if (event === void 0) {
      fail("INVALID_SESSION", `surface event ${String(seq)} is missing`, 409);
    }
    if (isReplacementSurfaceEvent(event) && replayMarker(event) === void 0) {
      fail(
        "UNSUPPORTED_TAIL",
        "the preserved tail crosses a compaction or another replacement checkpoint",
        409
      );
    }
    if (event.type === "user/message" && event.data.source.kind !== "user" && !isRegeneratedContext(event)) {
      fail(
        "UNSUPPORTED_TAIL",
        "the preserved tail contains non-regenerated user-role context",
        409
      );
    }
  }
  const tail = [];
  for (const turn of turns.slice(targetIndex + 1)) {
    const currentHumans = turn.humanMessages.filter((message2) => surface.has(message2.seq));
    if (currentHumans.length === 0) continue;
    if (currentHumans.length !== 1) {
      fail(
        "UNSUPPORTED_TAIL",
        `turn ${String(turn.turn)} does not contain exactly one ordinary user message`,
        409
      );
    }
    const message = currentHumans[0];
    if (message === void 0 || !hasReplaySafeTailSurface(turn, message, surface)) {
      fail(
        "UNSUPPORTED_TAIL",
        `turn ${String(turn.turn)} contains additional non-regenerated user-role context`,
        409
      );
    }
    const text = plainUserText(message);
    if (text === void 0) {
      fail(
        "UNSUPPORTED_TAIL",
        `turn ${String(turn.turn)} contains attachments or non-text content`,
        409
      );
    }
    tail.push(text);
  }
  return tail;
}
function buildRewindPlan(snapshot, request) {
  validateRequest(request);
  if (snapshot.session.id !== request.sessionId) {
    fail("INVALID_REQUEST", "sessionId does not match the loaded Session", 409);
  }
  const analysis = analyzeTurns(snapshot.events);
  if (analysis.openTurn !== null) {
    fail("SOURCE_BUSY", `turn ${String(analysis.openTurn)} is still running`, 409);
  }
  const surfaceNodes = [...foldSurface(snapshot.events).nodes];
  const surface = new Set(surfaceNodes);
  const targetIndex = analysis.closed.findIndex((turn) => turn.humanMessages.some((event) => event.seq === request.messageSeq));
  if (targetIndex === -1) {
    fail("MESSAGE_NOT_FOUND", `message seq ${String(request.messageSeq)} is not in a completed turn`, 404);
  }
  const targetTurn = analysis.closed[targetIndex];
  if (targetTurn === void 0) {
    fail("MESSAGE_NOT_FOUND", `message seq ${String(request.messageSeq)} is not in a completed turn`, 404);
  }
  const targetEvent = targetTurn.humanMessages[0];
  const before = targetEvent === void 0 ? void 0 : plainUserText(targetEvent);
  if (targetTurn.humanMessages.length !== 1 || targetEvent === void 0 || before === void 0) {
    fail("UNSUPPORTED_MESSAGE", "only a single plain-text user message can be edited", 409);
  }
  if (!surface.has(targetEvent.seq) || targetEvent.surfaceOp !== "append") {
    fail("MESSAGE_NOT_FOUND", `message seq ${String(request.messageSeq)} is no longer on the current surface`, 404);
  }
  if (!hasReplaySafeTargetSurface(targetTurn, targetEvent, surface)) {
    fail(
      "UNSUPPORTED_MESSAGE",
      "the target turn contains non-regenerated user-role context after the message",
      409
    );
  }
  const target = editableTurn(targetTurn);
  if (target === void 0) {
    fail("UNSUPPORTED_MESSAGE", "only a single plain-text user message can be edited", 409);
  }
  const cutIndex = messageInsertionIndex(snapshot.events, targetEvent, targetTurn.startIndex);
  if (cutIndex === void 0) {
    fail(
      "UNSUPPORTED_MESSAGE",
      "the target message has no unambiguous single-message insertion boundary",
      409
    );
  }
  const targetSurfaceIndex = surfaceNodes.indexOf(targetEvent.seq);
  if (targetSurfaceIndex < 0) {
    fail("MESSAGE_NOT_FOUND", `message seq ${String(request.messageSeq)} is no longer on the current surface`, 404);
  }
  const followups = [
    request.text,
    ...request.cascade === "preserve" ? preservedTail(
      snapshot.events,
      analysis.closed,
      targetIndex,
      surface,
      surfaceNodes.slice(targetSurfaceIndex + 1)
    ) : []
  ];
  return {
    target,
    surfaceNodes,
    shadowedSeqs: surfaceNodes.slice(targetSurfaceIndex),
    followups,
    model: projectModel(snapshot.events)
  };
}
function replayMarker(event) {
  if (event.type !== "assistant/message" || !isReplacementSurfaceEvent(event)) return void 0;
  const source = event.data.message.source;
  if (event.data.message.content.length !== 0 || source.kind !== "model" || source.provider !== REWIND_MARKER_PROVIDER || source.model !== REWIND_MARKER_MODEL || source.replayState === null || typeof source.replayState !== "object") {
    return void 0;
  }
  const marker = source.replayState;
  if (!hasExactOwnKeys(source.replayState, REWIND_REPLAY_MARKER_KEYS) || marker.kind !== REWIND_MARKER_KIND || marker.version !== REWIND_MARKER_VERSION || typeof marker.transactionId !== "string" || marker.transactionId === "" || !Number.isSafeInteger(marker.targetSeq) || (marker.targetSeq ?? -1) < 0 || marker.mode !== "rewind" && marker.mode !== "cleanup") return void 0;
  const sourceEventSeqs = event.sourceEventSeqs;
  if (sourceEventSeqs === void 0 || event.surfaceOp.start !== marker.targetSeq || sourceEventSeqs[0] !== event.surfaceOp.start || sourceEventSeqs.at(-1) !== event.surfaceOp.end) return void 0;
  return marker;
}
function listHiddenRanges(events) {
  const ranges = events.flatMap((event) => {
    const marker = replayMarker(event);
    if (marker === void 0 || marker.targetSeq > event.seq) return [];
    return [{ startSeq: marker.targetSeq, endSeq: event.seq }];
  }).sort((left, right) => left.startSeq - right.startSeq || left.endSeq - right.endSeq);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === void 0 || range.startSeq > previous.endSeq) {
      merged.push({ ...range });
    } else {
      previous.endSeq = Math.max(previous.endSeq, range.endSeq);
    }
  }
  return merged;
}
export {
  ConversationRewindError,
  REWIND_MARKER_KIND,
  REWIND_MARKER_MODEL,
  REWIND_MARKER_PROVIDER,
  REWIND_MARKER_VERSION,
  buildBranchSelectionPlan,
  buildRewindPlan,
  isRegeneratedContext,
  listEditableMessages,
  listHiddenRanges,
  plainUserText,
  projectBranchTree,
  projectModel,
  queryConversationBranch
};
//# sourceMappingURL=core.js.map
