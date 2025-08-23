import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
} from '..';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryProofRepository } from './MemoryProofRepository';

export class MemoryRepositories implements Repositories {
  mintRepository: MintRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;

  constructor() {
    this.mintRepository = new MemoryMintRepository();
    this.counterRepository = new MemoryCounterRepository();
    this.keysetRepository = new MemoryKeysetRepository();
    this.proofRepository = new MemoryProofRepository();
  }
}
