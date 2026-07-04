<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		class?: string;
		hover?: boolean;
		children: Snippet;
	}
	let { class: className = '', hover = false, children }: Props = $props();
</script>

<div
	class={cn(
		'rounded-xl border border-zinc-800 bg-zinc-950/50 backdrop-blur-sm',
		hover && 'transition-colors hover:border-zinc-700 hover:bg-zinc-900/40',
		className
	)}
>
	{@render children()}
</div>
