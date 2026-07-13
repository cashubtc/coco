import { OutputData, type OutputDataCreator } from '@cashu/cashu-ts';

/**
 * The built-in cashu-ts output construction behavior, exposed through its creator contract.
 */
export const DEFAULT_OUTPUT_DATA_CREATOR: OutputDataCreator = Object.freeze({
  createP2PKData: (...args: Parameters<OutputDataCreator['createP2PKData']>) =>
    OutputData.createP2PKData(...args),
  createSingleP2PKData: (...args: Parameters<OutputDataCreator['createSingleP2PKData']>) =>
    OutputData.createSingleP2PKData(...args),
  createRandomData: (...args: Parameters<OutputDataCreator['createRandomData']>) =>
    OutputData.createRandomData(...args),
  createSingleRandomData: (...args: Parameters<OutputDataCreator['createSingleRandomData']>) =>
    OutputData.createSingleRandomData(...args),
  createDeterministicData: (...args: Parameters<OutputDataCreator['createDeterministicData']>) =>
    OutputData.createDeterministicData(...args),
  createSingleDeterministicData: (
    ...args: Parameters<OutputDataCreator['createSingleDeterministicData']>
  ) => OutputData.createSingleDeterministicData(...args),
});
