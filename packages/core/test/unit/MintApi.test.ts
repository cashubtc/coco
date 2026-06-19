import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';

import { MintApi } from '../../api/MintApi';
import { ProofValidationError } from '../../models/Error';
import {
  MintService,
  type CheckPaymentMethodCapabilityInput,
  type ListPaymentMethodCapabilitiesInput,
  type PaymentMethodCapability,
  type PaymentMethodCapabilityCheck,
} from '../../services/MintService';
import { MemoryKeysetRepository } from '../../repositories/memory/MemoryKeysetRepository';
import { MemoryMintRepository } from '../../repositories/memory/MemoryMintRepository';
import type { Mint } from '../../models/Mint';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintInfo } from '../../types';

describe('MintApi payment method capabilities', () => {
  const mintUrl = 'https://mint.test';
  const now = Math.floor(Date.now() / 1000);

  const keysets = [
    {
      id: 'keyset-1',
      unit: 'sat',
      active: true,
      input_fee_ppk: 0,
    },
  ];

  const makeMintInfo = (nuts: Record<string, unknown>): MintInfo =>
    ({
      name: 'Capability Mint',
      version: '1.0.0',
      pubkey: 'pubkey',
      contact: [],
      nuts,
    }) as unknown as MintInfo;

  const createApi = async (mintInfo: MintInfo, updatedAt = now) => {
    const mintRepo = new MemoryMintRepository();
    const keysetRepo = new MemoryKeysetRepository();
    const adapter = {
      fetchMintInfo: mock(async () => mintInfo),
      fetchKeysets: mock(async () => ({ keysets })),
      fetchKeysForId: mock(async () => ({ '1': 'key-1' })),
    } as unknown as MintAdapter;
    const service = new MintService(mintRepo, keysetRepo, adapter);
    await mintRepo.addOrUpdateMint({
      mintUrl,
      name: mintUrl,
      mintInfo,
      trusted: true,
      createdAt: now,
      updatedAt,
    } satisfies Mint);

    return { api: new MintApi(service), adapter };
  };

  it('delegates public capability calls to the mint service', async () => {
    const checkInput: CheckPaymentMethodCapabilityInput = {
      mintUrl,
      operation: 'mint',
      method: 'custom-pay',
      unit: 'sat',
    };
    const listInput: ListPaymentMethodCapabilitiesInput = {
      mintUrl,
      operation: 'melt',
      unit: 'sat',
    };
    const checkResult: PaymentMethodCapabilityCheck = {
      supported: true,
      disabled: false,
      operation: 'mint',
      nut: 4,
      method: 'custom-pay',
      unit: 'sat',
    };
    const listResult: PaymentMethodCapability[] = [
      {
        operation: 'melt',
        nut: 5,
        method: 'custom-payout',
        unit: 'sat',
      },
    ];
    const checkPaymentMethodCapability = mock(async () => checkResult);
    const listPaymentMethodCapabilities = mock(async () => listResult);
    const api = new MintApi({
      checkPaymentMethodCapability,
      listPaymentMethodCapabilities,
    } as unknown as MintService);

    await expect(api.checkPaymentMethodCapability(checkInput)).resolves.toBe(checkResult);
    await expect(api.listPaymentMethodCapabilities(listInput)).resolves.toBe(listResult);
    expect(checkPaymentMethodCapability).toHaveBeenCalledWith(checkInput);
    expect(listPaymentMethodCapabilities).toHaveBeenCalledWith(listInput);
  });

  it('checks mint capabilities from cached NUT-04 metadata', async () => {
    const { api, adapter } = await createApi(
      makeMintInfo({
        '4': {
          disabled: false,
          methods: [
            {
              method: 'lnurl',
              unit: 'SAT',
              min_amount: 10,
              max_amount: 1000,
              options: { reusable: true },
            },
          ],
        },
      }),
    );

    const capability = await api.checkPaymentMethodCapability({
      mintUrl,
      operation: 'mint',
      method: 'lnurl',
      unit: 'sat',
    });

    expect(capability).toMatchObject({
      supported: true,
      disabled: false,
      operation: 'mint',
      nut: 4,
      method: 'lnurl',
      unit: 'sat',
      options: { reusable: true },
    });
    expect(capability.minAmount?.equals(Amount.from(10))).toBe(true);
    expect(capability.maxAmount?.equals(Amount.from(1000))).toBe(true);
    expect(adapter.fetchMintInfo).not.toHaveBeenCalled();
  });

  it('lists actionable capabilities with operation and unit filters', async () => {
    const { api } = await createApi(
      makeMintInfo({
        '4': {
          disabled: false,
          methods: [
            { method: 'bolt11', unit: 'sat' },
            { method: 'lnurl', unit: 'usd', min_amount: 5 },
          ],
        },
        '5': {
          disabled: false,
          methods: [
            { method: 'bolt11', unit: 'sat' },
            { method: 'pix', unit: 'usd', max_amount: 500 },
          ],
        },
      }),
    );

    await expect(api.listPaymentMethodCapabilities({ mintUrl })).resolves.toMatchObject([
      { operation: 'mint', nut: 4, method: 'bolt11', unit: 'sat' },
      { operation: 'mint', nut: 4, method: 'lnurl', unit: 'usd' },
      { operation: 'melt', nut: 5, method: 'bolt11', unit: 'sat' },
      { operation: 'melt', nut: 5, method: 'pix', unit: 'usd' },
    ]);

    const usdMeltCapabilities = await api.listPaymentMethodCapabilities({
      mintUrl,
      operation: 'melt',
      unit: 'USD',
    });

    expect(usdMeltCapabilities).toHaveLength(1);
    expect(usdMeltCapabilities[0]).toMatchObject({
      operation: 'melt',
      nut: 5,
      method: 'pix',
      unit: 'usd',
    });
    expect(usdMeltCapabilities[0]?.maxAmount?.equals(Amount.from(500))).toBe(true);
  });

  it('returns diagnostic details for unsupported, disabled, and missing capabilities', async () => {
    const { api: unsupportedApi } = await createApi(
      makeMintInfo({
        '4': {
          disabled: false,
          methods: [{ method: 'custom-pay', unit: 'sat' }],
        },
      }),
    );

    const unsupported = await unsupportedApi.checkPaymentMethodCapability({
      mintUrl,
      operation: 'mint',
      method: 'custom-pay',
      unit: 'usd',
    });

    expect(unsupported).toMatchObject({
      supported: false,
      disabled: false,
      operation: 'mint',
      nut: 4,
      method: 'custom-pay',
      unit: 'usd',
    });
    expect(unsupported.reason).toContain('NUT-04 method custom-pay does not support unit usd');

    const { api: disabledApi } = await createApi(
      makeMintInfo({
        '5': {
          disabled: true,
          methods: [{ method: 'custom-payout', unit: 'sat' }],
        },
      }),
    );

    const disabled = await disabledApi.checkPaymentMethodCapability({
      mintUrl,
      operation: 'melt',
      method: 'custom-payout',
      unit: 'sat',
    });

    expect(disabled).toMatchObject({
      supported: false,
      disabled: true,
      operation: 'melt',
      nut: 5,
      method: 'custom-payout',
      unit: 'sat',
    });
    expect(disabled.reason).toContain('NUT-05 is disabled');

    const { api: missingApi } = await createApi(makeMintInfo({}));

    const missing = await missingApi.checkPaymentMethodCapability({
      mintUrl,
      operation: 'mint',
      method: 'custom-pay',
      unit: 'sat',
    });

    expect(missing).toMatchObject({
      supported: false,
      disabled: false,
      operation: 'mint',
      nut: 4,
      method: 'custom-pay',
      unit: 'sat',
    });
    expect(missing.reason).toContain('NUT-04 method metadata is missing');
  });

  it('omits disabled NUT settings from capability listings', async () => {
    const { api } = await createApi(
      makeMintInfo({
        '4': {
          disabled: true,
          methods: [{ method: 'custom-pay', unit: 'sat' }],
        },
        '5': {
          disabled: false,
          methods: [{ method: 'custom-payout', unit: 'sat' }],
        },
      }),
    );

    await expect(api.listPaymentMethodCapabilities({ mintUrl })).resolves.toMatchObject([
      { operation: 'melt', nut: 5, method: 'custom-payout', unit: 'sat' },
    ]);
  });

  it('rejects invalid public operation inputs', async () => {
    const { api } = await createApi(makeMintInfo({}));
    const invalidOperation = 'swap' as never;

    await expect(
      api.checkPaymentMethodCapability({
        mintUrl,
        operation: invalidOperation,
        method: 'custom-pay',
        unit: 'sat',
      }),
    ).rejects.toThrow(ProofValidationError);

    await expect(
      api.listPaymentMethodCapabilities({
        mintUrl,
        operation: invalidOperation,
      }),
    ).rejects.toThrow(ProofValidationError);
  });
});
