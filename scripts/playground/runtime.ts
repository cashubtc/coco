import type { Output, Request, Response } from './protocol';
export class PlaygroundRuntime {
  private worker?: Worker;
  private pending?: {
    id?: number;
    resolve: (prepared: boolean) => void;
    reject: (error: Error) => void;
  };
  private nextId = 0;
  private generation = 0;
  constructor(
    private readonly output: (output: Output) => void,
    private readonly failed: () => void = () => {},
  ) {}
  async start(): Promise<void> {
    if (this.worker) throw new Error('Playground is already started.');
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve: () => resolve(), reject };
      worker.onmessage = ({ data }: MessageEvent<Response>) => {
        if (this.worker !== worker) return;
        if (data.type === 'output') this.output(data.output);
        else if (data.type === 'ready') this.finish(true);
        else if (data.type === 'fatal') {
          this.failed();
          this.finish(false, data.error);
          this.dispose();
        } else if (data.type === 'done' && this.pending?.id === data.id) {
          if (data.error) this.output({ level: 'error', text: data.error });
          // Runtime failures can leave bindings initialized; keep their type history.
          this.finish(data.prepared);
        }
      };
      worker.onerror = (event) => {
        if (this.worker !== worker) return;
        event.preventDefault();
        this.output({
          level: 'error',
          text: event.message || 'Execution worker failed. Reset to continue.',
        });
        this.failed();
        this.finish(false, event.message || 'Execution worker failed.');
        this.dispose();
      };
    });
  }
  execute(source: string): Promise<boolean> {
    if (!this.worker) return Promise.reject(new Error('Playground is not ready.'));
    if (this.pending) return Promise.reject(new Error('A snippet is already running.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending = { id, resolve, reject };
      this.send({ type: 'execute', id, source });
    });
  }
  async reset(): Promise<void> {
    const generation = ++this.generation;
    this.dispose();
    await this.start();
    if (generation !== this.generation) throw new Error('Reset superseded.');
  }
  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.finish(false, 'Execution stopped.');
    // Termination also cancels timers, module state and infinite loops immediately.
    worker?.terminate();
  }
  private send(message: Request) {
    this.worker?.postMessage(message);
  }
  private finish(prepared: boolean, error?: string) {
    const pending = this.pending;
    this.pending = undefined;
    if (error) pending?.reject(new Error(error));
    else pending?.resolve(prepared);
  }
}
