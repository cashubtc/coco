#!/usr/bin/env bun

// PROTOTYPE — throwaway validation of a controllable CDK payment-processor seam.

import assert from 'node:assert/strict';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createFakeInvoice } from 'fake-bolt11';

import { initializeCoco, MemoryRepositories, type Manager } from '../../packages/core/index.ts';

const CDK_VERSION = '0.17.0-rc.0';
const CDK_PROTOCOL_VERSION = '3.0.0';
const CDK_BINARY_SHA256 = 'd6868866b0b0873faa527d7cc949427c6e3d4e2a0b92b2ec6a99319c9f33eb29';
const MINT_PORT = 3338;
const PROCESSOR_PORT = 50051;
const MINT_URL = `http://127.0.0.1:${MINT_PORT}`;
const SCRATCH_DIR = join(tmpdir(), 'coco-cdk-payment-processor-prototype');
const CDK_BINARY_PATH = join(SCRATCH_DIR, `cdk-mintd-${CDK_VERSION}-x86_64`);
const PROTO_PATH = join(SCRATCH_DIR, 'payment_processor.proto');
const CONFIG_PATH = join(SCRATCH_DIR, 'config.toml');

type AmountMessage = {
  value: number;
  unit: string;
};

type PaymentIdentifier = {
  type: string;
  id?: string;
  hash?: string;
};

type IncomingPayment = {
  id: string;
  request: string;
  amount: AmountMessage;
  state: 'UNPAID' | 'PAID';
};

type OutgoingPayment = {
  quoteId: string;
  request: string;
  amount: AmountMessage;
  fee: AmountMessage;
  state: 'UNPAID' | 'PENDING' | 'PAID';
  callback?: grpc.sendUnaryData<Record<string, unknown>>;
};

type CreatePaymentRequest = {
  options?: {
    bolt11?: {
      amount?: AmountMessage;
    };
  };
};

type PaymentQuoteRequest = {
  request: string;
  quoteId: string;
  unit: string;
};

type MakePaymentRequest = {
  paymentOptions?: {
    bolt11?: {
      bolt11: string;
      quoteId: string;
    };
  };
};

type CheckPaymentRequest = {
  requestIdentifier?: PaymentIdentifier;
};

type ProcessorPackage = {
  CdkPaymentProcessor: {
    service: grpc.ServiceDefinition;
  };
};

function printState(label: string, state: unknown): void {
  console.log(`\n${label}`);
  console.log(JSON.stringify(state, null, 2));
}

function identifier(id: string): PaymentIdentifier {
  return {
    type: 'PAYMENT_IDENTIFIER_TYPE_CUSTOM_ID',
    id,
  };
}

function identifierValue(value: PaymentIdentifier | undefined): string | undefined {
  return value?.id ?? value?.hash;
}

function bolt11AmountSats(invoice: string): number {
  const match = /^ln(?:bc|tb|bcrt|tbs)(\d+)([munp]?)1/i.exec(invoice);
  assert(match, 'Prototype only supports amountful BOLT11 invoices');

  const amount = Number(match[1]);
  const satsPerUnit =
    match[2]?.toLowerCase() === 'm'
      ? 100_000
      : match[2]?.toLowerCase() === 'u'
        ? 100
        : match[2]?.toLowerCase() === 'n'
          ? 0.1
          : match[2]?.toLowerCase() === 'p'
            ? 0.0001
            : 100_000_000;
  const sats = amount * satsPerUnit;
  assert(Number.isSafeInteger(sats), `Invoice amount is not a whole satoshi: ${sats}`);
  return sats;
}

class ControllablePaymentProcessor {
  readonly incoming = new Map<string, IncomingPayment>();
  readonly outgoing = new Map<string, OutgoingPayment>();

  private readonly streams = new Set<grpc.ServerWritableStream<Record<string, never>, unknown>>();
  private readonly outgoingWaiters = new Set<() => void>();
  private nextIncomingId = 1;
  observedProtocolVersion?: string;

  settleIncoming(request: string): void {
    const payment = [...this.incoming.values()].find((candidate) => candidate.request === request);
    assert(payment, `Unknown incoming payment request: ${request}`);

    payment.state = 'PAID';
    const paymentReceived = {
      paymentReceived: {
        paymentIdentifier: identifier(payment.id),
        paymentAmount: payment.amount,
        paymentId: `settlement-${payment.id}`,
      },
    };

    for (const stream of this.streams) stream.write(paymentReceived);
    printState('Payment processor settled incoming payment', payment);
  }

  async waitForOutgoing(): Promise<OutgoingPayment> {
    const pending = [...this.outgoing.values()].find((payment) => payment.state === 'PENDING');
    if (pending) return pending;

    await new Promise<void>((resolve) => this.outgoingWaiters.add(resolve));
    return this.waitForOutgoing();
  }

  settleOutgoing(quoteId: string): void {
    const payment = this.outgoing.get(quoteId);
    assert(payment, `Unknown outgoing payment quote: ${quoteId}`);
    assert(payment.callback, `Outgoing payment ${quoteId} has not been initiated`);

    payment.state = 'PAID';
    const response = this.makePaymentResponse(payment);
    payment.callback(null, response);
    payment.callback = undefined;
    printState('Payment processor settled outgoing payment', payment);
  }

  implementation(): grpc.UntypedServiceImplementation {
    return {
      getSettings: this.getSettings,
      createPayment: this.createPayment,
      getPaymentQuote: this.getPaymentQuote,
      makePayment: this.makePayment,
      checkIncomingPayment: this.checkIncomingPayment,
      checkOutgoingPayment: this.checkOutgoingPayment,
      waitPaymentEvent: this.waitPaymentEvent,
    };
  }

  private observeProtocol(call: { metadata: grpc.Metadata }): void {
    const header = call.metadata.get('x-cdk-protocol-version')[0];
    this.observedProtocolVersion = typeof header === 'string' ? header : undefined;
  }

  private readonly getSettings: grpc.handleUnaryCall<
    Record<string, never>,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    callback(null, {
      unit: 'sat',
      bolt11: {
        mpp: false,
        amountless: false,
        invoiceDescription: true,
      },
    });
  };

  private readonly createPayment: grpc.handleUnaryCall<
    CreatePaymentRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const amount = call.request.options?.bolt11?.amount;
    assert(amount, 'Prototype only supports amountful BOLT11 incoming payments');

    const id = `incoming-${this.nextIncomingId++}`;
    const payment: IncomingPayment = {
      id,
      request: createFakeInvoice(amount.value),
      amount,
      state: 'UNPAID',
    };
    this.incoming.set(id, payment);
    printState('Payment processor created incoming payment', payment);

    callback(null, {
      requestIdentifier: identifier(id),
      request: payment.request,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
  };

  private readonly getPaymentQuote: grpc.handleUnaryCall<
    PaymentQuoteRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const amountValue = bolt11AmountSats(call.request.request);

    const payment: OutgoingPayment = {
      quoteId: call.request.quoteId,
      request: call.request.request,
      amount: { value: amountValue, unit: call.request.unit },
      fee: { value: 1, unit: call.request.unit },
      state: 'UNPAID',
    };
    this.outgoing.set(payment.quoteId, payment);
    printState('Payment processor quoted outgoing payment', payment);

    callback(null, {
      requestIdentifier: identifier(payment.quoteId),
      amount: payment.amount,
      fee: payment.fee,
      state: 'QUOTE_STATE_UNPAID',
    });
  };

  private readonly makePayment: grpc.handleUnaryCall<MakePaymentRequest, Record<string, unknown>> =
    (call, callback) => {
      this.observeProtocol(call);
      const options = call.request.paymentOptions?.bolt11;
      assert(options, 'Prototype only supports BOLT11 outgoing payments');

      const payment = this.outgoing.get(options.quoteId);
      assert(payment, `No outgoing quote registered for ${options.quoteId}`);
      payment.state = 'PENDING';
      payment.callback = callback;
      printState('Payment processor is holding outgoing payment', payment);

      for (const waiter of this.outgoingWaiters) waiter();
      this.outgoingWaiters.clear();
    };

  private readonly checkIncomingPayment: grpc.handleUnaryCall<
    CheckPaymentRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const id = identifierValue(call.request.requestIdentifier);
    const payment = id ? this.incoming.get(id) : undefined;
    const payments =
      payment?.state === 'PAID'
        ? [
            {
              paymentIdentifier: identifier(payment.id),
              paymentAmount: payment.amount,
              paymentId: `settlement-${payment.id}`,
            },
          ]
        : [];

    callback(null, { payments });
  };

  private readonly checkOutgoingPayment: grpc.handleUnaryCall<
    CheckPaymentRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const quoteId = identifierValue(call.request.requestIdentifier);
    const payment = quoteId ? this.outgoing.get(quoteId) : undefined;
    assert(payment, `No outgoing payment registered for ${quoteId}`);
    callback(null, this.makePaymentResponse(payment));
  };

  private readonly waitPaymentEvent: grpc.handleServerStreamingCall<
    Record<string, never>,
    unknown
  > = (call) => {
    this.observeProtocol(call);
    this.streams.add(call);
    call.on('cancelled', () => this.streams.delete(call));
    call.on('close', () => this.streams.delete(call));
  };

  private makePaymentResponse(payment: OutgoingPayment): Record<string, unknown> {
    const status =
      payment.state === 'PAID'
        ? 'QUOTE_STATE_PAID'
        : payment.state === 'PENDING'
          ? 'QUOTE_STATE_PENDING'
          : 'QUOTE_STATE_UNPAID';

    return {
      paymentIdentifier: identifier(payment.quoteId),
      paymentProof: payment.state === 'PAID' ? `proof-${payment.quoteId}` : undefined,
      status,
      totalSpent: {
        value: payment.state === 'PAID' ? payment.amount.value + payment.fee.value : 0,
        unit: payment.amount.unit,
      },
    };
  }
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  assert(response.ok, `Failed to download ${url}: ${response.status}`);
  await Bun.write(path, await response.arrayBuffer());
}

async function prepareScratchFiles(): Promise<void> {
  await rm(SCRATCH_DIR, { recursive: true, force: true });
  await mkdir(SCRATCH_DIR, { recursive: true });

  const binaryUrl =
    `https://github.com/cashubtc/cdk/releases/download/v${CDK_VERSION}/` +
    `cdk-mintd-${CDK_VERSION}-x86_64`;
  const protoUrl =
    `https://raw.githubusercontent.com/cashubtc/cdk/v${CDK_VERSION}/` +
    'crates/cdk-payment-processor/src/proto/payment_processor.proto';

  await Promise.all([download(binaryUrl, CDK_BINARY_PATH), download(protoUrl, PROTO_PATH)]);

  const binaryHash = createHash('sha256')
    .update(Buffer.from(await Bun.file(CDK_BINARY_PATH).arrayBuffer()))
    .digest('hex');
  assert.equal(binaryHash, CDK_BINARY_SHA256, 'Downloaded CDK binary checksum mismatch');
  await chmod(CDK_BINARY_PATH, 0o755);

  await Bun.write(
    CONFIG_PATH,
    `[info]
url = "${MINT_URL}/"
listen_host = "127.0.0.1"
listen_port = ${MINT_PORT}
mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

[database]
engine = "sqlite"

[ln]
ln_backend = "grpcprocessor"

[grpc_processor]
supported_units = ["sat"]
addr = "http://127.0.0.1"
port = ${PROCESSOR_PORT}
`,
  );
}

async function startProcessor(processor: ControllablePaymentProcessor): Promise<grpc.Server> {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: Number,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    cdk_payment_processor: ProcessorPackage;
  };

  const server = new grpc.Server();
  server.addService(
    loaded.cdk_payment_processor.CdkPaymentProcessor.service,
    processor.implementation(),
  );

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      `127.0.0.1:${PROCESSOR_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => (error ? reject(error) : resolve()),
    );
  });
  return server;
}

async function waitForMint(mintProcess: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (mintProcess.exitCode !== null) {
      throw new Error(`CDK mintd exited before becoming ready (${mintProcess.exitCode})`);
    }
    try {
      const response = await fetch(`${MINT_URL}/v1/info`);
      if (response.ok) return;
    } catch {
      // Expected while mintd starts.
    }
    await Bun.sleep(100);
  }
  throw new Error('Timed out waiting for CDK mintd');
}

async function mintAndMelt(processor: ControllablePaymentProcessor): Promise<void> {
  const repositories = new MemoryRepositories();
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const manager = await initializeCoco({
    repo: repositories,
    seedGetter: async () => seed,
    watchers: {
      mintOperationWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
    },
    processors: {
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
    },
  });

  try {
    await manager.mint.addMint(MINT_URL, { trusted: true });

    const mintQuote = await manager.quotes.mint.create({
      mintUrl: MINT_URL,
      method: 'bolt11',
      amount: 100,
      unit: 'sat',
    });
    assert.equal(mintQuote.state, 'UNPAID');
    printState('Coco observed mint quote', {
      quoteId: mintQuote.quoteId,
      state: mintQuote.state,
      amount: mintQuote.amount.toNumber(),
    });

    processor.settleIncoming(mintQuote.request);
    const paidQuote = await manager.quotes.mint.refresh({
      mintUrl: MINT_URL,
      quoteId: mintQuote.quoteId,
    });
    assert.equal(paidQuote.state, 'PAID');

    const preparedMint = await manager.ops.mint.prepare({ quote: paidQuote, amount: 100 });
    const finalizedMint = await manager.ops.mint.execute(preparedMint.id);
    assert.equal(finalizedMint.state, 'finalized');

    const balanceAfterMint = await spendableBalance(manager);
    assert(
      balanceAfterMint >= 100,
      `Expected at least 100 sat after mint, got ${balanceAfterMint}`,
    );
    printState('Coco finalized mint operation', {
      operationId: finalizedMint.id,
      state: finalizedMint.state,
      spendableBalance: balanceAfterMint,
    });

    const outgoingInvoice = createFakeInvoice(20);
    const meltQuote = await manager.quotes.melt.create({
      mintUrl: MINT_URL,
      method: 'bolt11',
      methodData: { invoice: outgoingInvoice },
      unit: 'sat',
    });
    const preparedMelt = await manager.ops.melt.prepare({ quote: meltQuote });

    const meltExecution = manager.ops.melt.execute(preparedMelt.id);
    const pendingPayment = await processor.waitForOutgoing();
    assert.equal(pendingPayment.quoteId, meltQuote.quoteId);
    processor.settleOutgoing(pendingPayment.quoteId);

    const finalizedMelt = await meltExecution;
    assert.equal(finalizedMelt.state, 'finalized');
    printState('Coco finalized melt operation', {
      operationId: finalizedMelt.id,
      quoteId: finalizedMelt.quoteId,
      state: finalizedMelt.state,
      effectiveFee: finalizedMelt.effectiveFee?.toNumber(),
      spendableBalance: await spendableBalance(manager),
    });
  } finally {
    await manager.dispose();
  }
}

async function spendableBalance(manager: Manager): Promise<number> {
  const balances = await manager.wallet.balances.byMint({
    mintUrls: [MINT_URL],
    units: ['sat'],
  });
  return balances[MINT_URL]?.spendable.toNumber() ?? 0;
}

async function main(): Promise<void> {
  console.log('PROTOTYPE: controllable CDK payment processor');
  console.log(`Pinned CDK version: ${CDK_VERSION}`);

  await prepareScratchFiles();
  const processor = new ControllablePaymentProcessor();
  const grpcServer = await startProcessor(processor);
  const mintProcess = Bun.spawn(
    [CDK_BINARY_PATH, '--work-dir', join(SCRATCH_DIR, 'mint'), '--config', CONFIG_PATH],
    { stdout: 'inherit', stderr: 'inherit' },
  );

  try {
    await waitForMint(mintProcess);
    assert.equal(processor.observedProtocolVersion, CDK_PROTOCOL_VERSION);
    printState('CDK connected to the payment processor', {
      mintUrl: MINT_URL,
      protocolVersion: processor.observedProtocolVersion,
    });

    await mintAndMelt(processor);
    console.log(
      '\nVERDICT: the controllable gRPC payment-processor seam works for Coco mint and melt.',
    );
  } finally {
    mintProcess.kill();
    await mintProcess.exited;
    await new Promise<void>((resolve) => grpcServer.tryShutdown(() => resolve()));
    await rm(SCRATCH_DIR, { recursive: true, force: true });
  }
}

await main();
