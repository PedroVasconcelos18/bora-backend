export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface SendPushParams {
  endpoint: string;
  keys: PushSubscriptionKeys;
  payload: PushPayload;
}

export interface IPushProvider {
  send(params: SendPushParams): Promise<void>;
}
