import type { MeltOpsApi } from './MeltOpsApi';
import type { ReceiveOpsApi } from './ReceiveOpsApi';
import type { SendOpsApi } from './SendOpsApi';

export class OpsApi {
  constructor(
    readonly send: SendOpsApi,
    readonly receive: ReceiveOpsApi,
    readonly melt: MeltOpsApi,
  ) {}
}
