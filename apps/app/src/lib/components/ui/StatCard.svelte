<script lang="ts">
	import type { Component } from 'svelte';
	import Card from './Card.svelte';
	import { cn } from '$lib/utils';

	interface Props {
		label: string;
		value: string;
		sub?: string;
		icon?: Component;
		accent?: string;
	}
	let { label, value, sub, icon: Icon, accent = 'text-indigo-400' }: Props = $props();
</script>

<Card class="p-4">
	<div class="flex items-start justify-between">
		<div>
			<div class="font-mono text-[10px] tracking-wider text-zinc-500 uppercase">{label}</div>
			<div class="mt-1 text-2xl font-semibold text-zinc-100">{value}</div>
			{#if sub}<div class="mt-0.5 text-xs text-zinc-500">{sub}</div>{/if}
		</div>
		{#if Icon}
			<div class={cn('rounded-lg bg-zinc-900/60 p-2', accent)}>
				<Icon class="h-4 w-4" />
			</div>
		{/if}
	</div>
</Card>
