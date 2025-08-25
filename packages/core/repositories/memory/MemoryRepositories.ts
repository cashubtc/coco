import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
} from '..';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';

export class MemoryRepositories implements Repositories {
  mintRepository: MintRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;

  constructor() {
    this.mintRepository = new MemoryMintRepository();
    this.counterRepository = new MemoryCounterRepository();
    this.keysetRepository = new MemoryKeysetRepository();
    this.proofRepository = new MemoryProofRepository();
    this.mintQuoteRepository = new MemoryMintQuoteRepository();
  }
}
