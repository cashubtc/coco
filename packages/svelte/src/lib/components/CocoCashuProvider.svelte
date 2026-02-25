<script lang="ts">
  import type { Manager } from 'coco-cashu-core';
  import type { Snippet } from 'svelte';
  import { setManagerContext } from '../context.js';

  let { manager, children }: { manager: Manager; children: Snippet } = $props();

  // setContext must be called synchronously during component init,
  // NOT inside onMount — otherwise child components won't see it.
  setManagerContext(manager);
</script>

{@render children()}
