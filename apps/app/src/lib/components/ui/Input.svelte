<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils';

	interface Props extends HTMLInputAttributes {
		class?: string;
		value?: string;
	}
	let { class: className = '', value = $bindable(''), ...rest }: Props = $props();
</script>

<input
	bind:value
	class={cn(
		'h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none',
		className
	)}
	{...rest}
/>
