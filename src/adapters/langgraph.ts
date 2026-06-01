import type { MessageReceipt, MessagesResponse, SendMessageRequest, TrunkClient } from "../sdk/index.js";

export type LangGraphTrunkState = Record<string, unknown>;

export type LangGraphSendConfig<State extends LangGraphTrunkState> = {
  to: string | ((state: State) => string);
  type: SendMessageRequest["type"] | ((state: State) => SendMessageRequest["type"]);
  payload: SendMessageRequest["payload"] | ((state: State) => SendMessageRequest["payload"]);
  threadId?: string | ((state: State) => string | undefined);
  replyTo?: string | ((state: State) => string | undefined);
  outputKey?: string;
};

export type LangGraphInboxConfig<State extends LangGraphTrunkState> = {
  status?: string | ((state: State) => string | undefined);
  limit?: number | ((state: State) => number | undefined);
  outputKey?: string;
};

export function createTrunkSendNode<State extends LangGraphTrunkState>(
  client: Pick<TrunkClient, "send">,
  config: LangGraphSendConfig<State>
): (state: State) => Promise<State & Record<string, MessageReceipt>> {
  return async (state: State) => {
    const receipt = await client.send({
      to: resolve(config.to, state),
      type: resolve(config.type, state),
      payload: resolve(config.payload, state),
      thread_id: config.threadId ? resolve(config.threadId, state) : undefined,
      reply_to: config.replyTo ? resolve(config.replyTo, state) : undefined,
    });
    return {
      ...state,
      [config.outputKey ?? "trunk_receipt"]: receipt,
    };
  };
}

export function createTrunkInboxNode<State extends LangGraphTrunkState>(
  client: Pick<TrunkClient, "inbox">,
  config: LangGraphInboxConfig<State> = {}
): (state: State) => Promise<State & Record<string, MessagesResponse["messages"]>> {
  return async (state: State) => {
    const inbox = await client.inbox({
      status: config.status ? resolve(config.status, state) : undefined,
      limit: config.limit ? resolve(config.limit, state) : undefined,
    });
    return {
      ...state,
      [config.outputKey ?? "trunk_inbox"]: inbox.messages,
    };
  };
}

function resolve<State, Value>(value: Value | ((state: State) => Value), state: State): Value {
  return typeof value === "function" ? (value as (state: State) => Value)(state) : value;
}
