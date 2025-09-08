export type JsonRpcId = number;

export type WsRequestMethod = 'subscribe' | 'unsubscribe';

export type SubscriptionKind = 'bolt11_mint_quote' | 'bolt11_melt_quote' | 'proof_state';

export type UnsubscribeHandler = () => Promise<void>;

export interface SubscribeParams {
  kind: SubscriptionKind;
  subId: string;
  filters: string[];
}

export interface UnsubscribeParams {
  subId: string;
}

export type WsRequest = {
  jsonrpc: '2.0';
  method: WsRequestMethod;
  params: SubscribeParams | UnsubscribeParams;
  id: JsonRpcId;
};

export type WsResponse = {
  jsonrpc: '2.0';
  result?: { status: 'OK'; subId: string };
  error?: { code: number; message: string };
  id: JsonRpcId;
};

export type WsNotification<TPayload> = {
  jsonrpc: '2.0';
  method: 'subscribe';
  params: { subId: string; payload: TPayload };
};
