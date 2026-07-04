<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		actions?: Snippet;
	}
	let { title, description, actions }: Props = $props();
</script>

<div class="mb-6 flex items-start justify-between gap-4">
	<div>
		<h1 class="text-xl font-semibold tracking-tight text-zinc-100">{title}</h1>
		{#if description}<p class="mt-1 text-sm text-zinc-500">{description}</p>{/if}
	</div>
	{#if actions}<div class="flex items-center gap-2">{@render actions()}</div>{/if}
</div>
